import throttle from "lodash/throttle";
import shuffle from "lodash/shuffle";
import { RealTime, Peer } from "@webxdc/realtime";
import { db } from "~/lib/storage";

const CHUNK_SIZE = 64 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 4;
const REQUEST_TIMEOUT = 10000;
const FALLBACK_REQUEST_DELAY = 15000;
const FALLBACK_REQUEST_RETRY = 60000;
const FALLBACK_REQUEST_BATCH_SIZE = 16;
const FALLBACK_CHUNK_REPLY_TTL = 5 * 60 * 1000;
const FALLBACK_LAST_SERIAL_KEY = "__filesync__.fallbackLastSerial";
const FALLBACK_DEFAULT_SEND_INTERVAL = 10000;

type SetFilesCallback = (files: FileMeta[]) => void;

type QueuedFallbackUpdate = {
  key: string;
  update: FallbackUpdate;
};

export class FileManager {
  private realtime: RealTime<State, Payload>;
  private setFiles: SetFilesCallback;
  private requests = new Map<string, PeerRequest>();
  private syncTimer: number | null = null;
  private fallbackRequestTimer: number | null = null;
  private fallbackQueueTimer: number | null = null;
  private fallbackQueue: QueuedFallbackUpdate[] = [];
  private fallbackQueuedKeys = new Set<string>();
  private fallbackRequestTimes = new Map<string, number>();
  private fallbackChunkReplyTimes = new Map<string, number>();
  private fallbackProcessing = Promise.resolve();
  private beforeUnloadHandler: (() => void) | null = null;
  private fallbackListenerStarted = false;
  private started = false;
  private stopped = false;

  constructor(
    setPeers: (peers: Peer<State>[]) => void,
    setFiles: SetFilesCallback,
  ) {
    const throttledSetFiles = throttle(setFiles, 400);
    this.setFiles = (files: FileMeta[]) => {
      this.realtime.setState({ files });
      throttledSetFiles(
        files
          .filter((file) => file.size >= 0)
          .sort((a, b) => b.lastModified - a.lastModified),
      );
    };
    const throttledSetPeers = throttle(setPeers, 400);
    const onPeersChanged = async (peers: Peer<State>[]) => {
      for (const [key, req] of this.requests) {
        if (!peers.find((p) => p.id === req.peer)) this.requests.delete(key);
      }
      await this.syncFileList(peers);
      throttledSetPeers(peers);
    };
    const onPayload = async (_deviceId: string, payload: Payload) => {
      await this.processPayload(payload);
    };
    this.realtime = new RealTime({
      onPeersChanged,
      onPayload,
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    this.setFiles(await db.files.toArray());
    this.startFallbackListener();
    this.realtime.connect();
    this.beforeUnloadHandler = () => this.stop();
    window.addEventListener("beforeunload", this.beforeUnloadHandler);
    this.syncTimer = window.setTimeout(() => void this.syncChunks(), 100);
    this.scheduleFallbackRequests(FALLBACK_REQUEST_DELAY);
  }

  stop() {
    this.stopped = true;
    this.realtime.disconnect();
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    if (this.fallbackRequestTimer !== null) {
      window.clearTimeout(this.fallbackRequestTimer);
    }
    if (this.fallbackQueueTimer !== null) {
      window.clearTimeout(this.fallbackQueueTimer);
    }
    if (this.beforeUnloadHandler) {
      window.removeEventListener("beforeunload", this.beforeUnloadHandler);
    }
    this.syncTimer = null;
    this.fallbackRequestTimer = null;
    this.fallbackQueueTimer = null;
    this.beforeUnloadHandler = null;
    this.started = false;
  }

  async deleteFile(id: string) {
    const tombstone: FileMeta = {
      id,
      pending: [],
      name: "",
      lastModified: Date.now(),
      size: -1,
      type: "",
      sentBytes: 0,
    };
    await db.transaction("rw", db.files, db.chunks, async () => {
      await db.chunks.where("file").equals(id).delete();
      await db.files.put(tombstone);
    });
    this.setFiles(await db.files.toArray());
    this.queueFallbackMeta(tombstone);
  }

  async exportFile(meta: FileMeta) {
    const blob = await this.getFileBlob(meta);
    window.webxdc.sendToChat({
      file: {
        name: meta.name,
        blob,
      },
    });
  }

  async getFileBlob(meta: FileMeta): Promise<Blob> {
    if (meta.pending.length > 0) {
      throw new Error("File is not fully downloaded yet.");
    }

    const chunks = await db.chunks.where("file").equals(meta.id).sortBy("id");
    return new Blob(
      chunks.map((chunk) => chunk.blob),
      { type: meta.type },
    );
  }

  async importFile(file: File) {
    let meta: FileMeta | null = null;
    await db.transaction("rw", db.files, db.chunks, async () => {
      const id = getRandomUUID();
      meta = {
        id,
        pending: [],
        name: file.name,
        lastModified: file.lastModified || Date.now(),
        size: file.size,
        type: file.type,
        sentBytes: 0,
      };
      await db.files.add(meta);
      for (let i = 0; i < getChunkCount(file.size); i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        await db.chunks.add({
          file: id,
          id: i,
          blob: file.slice(start, end),
        });
      }
    });
    this.setFiles(await db.files.toArray());
    if (meta) this.queueFallbackMeta(meta);
  }

  getDownloadProgress(file: FileMeta): number {
    const total = getChunkCount(file.size);
    if (total === 0) return 100;
    const done = total - file.pending.length;
    return Math.floor((done / total) * 100);
  }

  private async processPayload(payload: Payload) {
    if ("request" in payload) {
      const req = payload.request;
      if (req.peer === this.realtime.getDeviceId()) {
        const file = await db.files.get(req.file);
        if (file) {
          const chunk = await db.chunks
            .where({ file: req.file, id: req.chunk })
            .first();
          if (chunk) {
            await this.sendResponse(file.lastModified, chunk);
          }
        }
      }
    } else if ("response" in payload) {
      const res = payload.response;
      await this.storeChunk(
        res.file,
        res.lastModified,
        res.chunk,
        new Blob([res.data]),
      );
    } else {
      console.error("unexpected payload", payload);
    }
  }

  private async sendResponse(lastModified: number, chunk: Chunk) {
    const data = await blobToUint8Array(chunk.blob);
    const response = {
      file: chunk.file,
      lastModified,
      chunk: chunk.id,
      data,
    };
    this.realtime.sendPayload({ response });
    await this.addSentBytes(chunk.file, data.byteLength);
  }

  private async sendRequest(request: PeerRequest) {
    this.requests.set(
      getChunkKey(request.file, request.lastModified, request.chunk),
      request,
    );
    this.realtime.sendPayload({ request });
  }

  private async createRequest(
    meta: FileMeta,
    chunkId: number,
  ): Promise<PeerRequest | null> {
    for (const peer of shuffle(this.realtime.getPeers())) {
      const file = peer.state.files.find((f: FileMeta) => f.id === meta.id);
      if (
        file &&
        file.lastModified === meta.lastModified &&
        file.pending.indexOf(chunkId) < 0
      ) {
        return {
          time: Date.now(),
          file: meta.id,
          lastModified: meta.lastModified,
          chunk: chunkId,
          peer: peer.id,
        };
      }
    }
    return null;
  }

  private async syncChunks() {
    if (this.stopped) return;

    const now = Date.now();
    for (const [key, req] of this.requests) {
      if (now - req.time > REQUEST_TIMEOUT) this.requests.delete(key);
    }

    if (this.requests.size < MAX_IN_FLIGHT_REQUESTS) {
      const files = this.realtime.getState()?.files || [];
      for (const file of files) {
        if (file.pending.length === 0 || file.size < 0) continue;
        for (const chunkId of shuffle(file.pending)) {
          if (this.requests.size >= MAX_IN_FLIGHT_REQUESTS) break;
          const key = getChunkKey(file.id, file.lastModified, chunkId);
          if (this.requests.has(key)) continue;
          const request = await this.createRequest(file, chunkId);
          if (request) await this.sendRequest(request);
        }
        if (this.requests.size >= MAX_IN_FLIGHT_REQUESTS) break;
      }
    }

    this.syncTimer = window.setTimeout(
      () => void this.syncChunks(),
      this.requests.size ? 100 : 500,
    );
  }

  private async syncFileList(peers: Peer<State>[]) {
    let changed = false;
    for (const peer of peers) {
      for (const file of peer.state.files) {
        changed = (await this.applyRemoteMeta(toAnnouncement(file))) || changed;
      }
    }
    if (changed) {
      this.setFiles(await db.files.toArray());
      this.scheduleFallbackRequests(FALLBACK_REQUEST_DELAY);
    }
  }

  private startFallbackListener() {
    if (this.fallbackListenerStarted) return;
    this.fallbackListenerStarted = true;
    const lastSerial =
      Number(localStorage.getItem(FALLBACK_LAST_SERIAL_KEY)) || 0;
    window.webxdc.setUpdateListener((update) => {
      this.fallbackProcessing = this.fallbackProcessing
        .then(() => this.processFallbackUpdate(update))
        .catch((error) => console.error("fallback update failed", error));
    }, lastSerial);
  }

  private async processFallbackUpdate(update: {
    payload: unknown;
    serial: number;
  }) {
    try {
      const payload = update.payload;
      if (!isFallbackUpdate(payload)) return;
      if (payload.sender === this.realtime.getDeviceId()) return;

      if (payload.type === "file-meta") {
        const changed = await this.applyRemoteMeta(payload.file);
        if (changed) this.setFiles(await db.files.toArray());
        this.scheduleFallbackRequests(FALLBACK_REQUEST_DELAY);
      } else if (payload.type === "chunk-request") {
        await this.handleFallbackChunkRequest(payload);
      } else if (payload.type === "chunk") {
        if (payload.meta) {
          const changed = await this.applyRemoteMeta(payload.meta);
          if (changed) this.setFiles(await db.files.toArray());
        }
        const changed = await this.storeChunk(
          payload.file,
          payload.lastModified,
          payload.chunk,
          new Blob([base64ToUint8Array(payload.data)]),
        );
        if (changed) this.scheduleFallbackRequests(FALLBACK_REQUEST_DELAY);
      }
    } finally {
      if (Number.isFinite(update.serial)) {
        localStorage.setItem(FALLBACK_LAST_SERIAL_KEY, String(update.serial));
      }
    }
  }

  private async applyRemoteMeta(meta: FileAnnouncement): Promise<boolean> {
    const local = await db.files.get(meta.id);
    if (!local) {
      await db.files.add({
        ...meta,
        pending: createPendingChunks(meta.size),
        sentBytes: 0,
      });
      return true;
    }
    if (local.lastModified >= meta.lastModified) return false;

    const pending = createPendingChunks(meta.size);
    await db.transaction("rw", db.files, db.chunks, async () => {
      await db.files.put({
        ...meta,
        pending,
        sentBytes: 0,
      });
      await db.chunks.where("file").equals(meta.id).delete();
    });
    return true;
  }

  private async storeChunk(
    fileId: string,
    lastModified: number,
    chunkId: number,
    blob: Blob,
  ): Promise<boolean> {
    const key = getChunkKey(fileId, lastModified, chunkId);
    this.requests.delete(key);

    const file = await db.files.get(fileId);
    if (
      !file ||
      file.lastModified !== lastModified ||
      file.size < 0 ||
      file.pending.indexOf(chunkId) < 0
    ) {
      return false;
    }

    const pending = file.pending.filter((chunk: number) => chunk !== chunkId);
    await db.transaction("rw", db.files, db.chunks, async () => {
      await db.files.put({ ...file, pending });
      await db.chunks.put({
        file: fileId,
        id: chunkId,
        blob,
      });
    });
    this.setFiles(await db.files.toArray());
    return true;
  }

  private async addSentBytes(fileId: string, bytes: number) {
    if (bytes <= 0) return;

    await db.transaction("rw", db.files, async () => {
      const file = await db.files.get(fileId);
      if (!file || file.size < 0) return;
      await db.files.put({
        ...file,
        sentBytes: (file.sentBytes || 0) + bytes,
      });
    });
    this.setFiles(await db.files.toArray());
  }

  private scheduleFallbackRequests(delay: number) {
    if (this.stopped || this.fallbackRequestTimer !== null) return;
    this.fallbackRequestTimer = window.setTimeout(() => {
      this.fallbackRequestTimer = null;
      void this.queueMissingFallbackRequests();
    }, delay);
  }

  private async queueMissingFallbackRequests() {
    const files = await db.files.toArray();
    const now = Date.now();
    let hasPending = false;

    for (const file of files) {
      if (file.size < 0 || file.pending.length === 0) continue;
      hasPending = true;
      const chunks: number[] = [];
      for (const chunkId of shuffle(file.pending)) {
        const key = getChunkKey(file.id, file.lastModified, chunkId);
        if (this.requests.has(key)) continue;
        if (
          (this.fallbackRequestTimes.get(key) || 0) + FALLBACK_REQUEST_RETRY >
          now
        ) {
          continue;
        }
        this.fallbackRequestTimes.set(key, now);
        chunks.push(chunkId);
        if (chunks.length >= FALLBACK_REQUEST_BATCH_SIZE) break;
      }
      if (chunks.length > 0) {
        this.queueFallbackUpdate(
          {
            v: 1,
            type: "chunk-request",
            sender: this.realtime.getDeviceId(),
            file: file.id,
            lastModified: file.lastModified,
            chunks,
          },
          `request:${file.id}:${file.lastModified}:${chunks.join(",")}`,
        );
        break;
      }
    }

    if (hasPending) this.scheduleFallbackRequests(FALLBACK_REQUEST_RETRY);
  }

  private async handleFallbackChunkRequest(update: FallbackChunkRequest) {
    const file = await db.files.get(update.file);
    if (!file || file.lastModified !== update.lastModified || file.size < 0) {
      return;
    }

    const now = Date.now();
    for (const chunkId of update.chunks.slice(0, FALLBACK_REQUEST_BATCH_SIZE)) {
      const key = getChunkKey(file.id, file.lastModified, chunkId);
      if (
        (this.fallbackChunkReplyTimes.get(key) || 0) +
          FALLBACK_CHUNK_REPLY_TTL >
        now
      ) {
        continue;
      }
      if (file.pending.indexOf(chunkId) >= 0) continue;
      const chunk = await db.chunks
        .where({ file: file.id, id: chunkId })
        .first();
      if (!chunk) continue;
      this.fallbackChunkReplyTimes.set(key, now);
      this.queueFallbackUpdate(
        {
          v: 1,
          type: "chunk",
          sender: this.realtime.getDeviceId(),
          file: file.id,
          lastModified: file.lastModified,
          chunk: chunkId,
          data: await blobToBase64(chunk.blob),
          meta: toAnnouncement(file),
        },
        `chunk:${file.id}:${file.lastModified}:${chunkId}`,
      );
    }
  }

  private queueFallbackMeta(file: FileMeta) {
    this.queueFallbackUpdate(
      {
        v: 1,
        type: "file-meta",
        sender: this.realtime.getDeviceId(),
        file: toAnnouncement(file),
      },
      `meta:${file.id}:${file.lastModified}`,
      true,
    );
  }

  private queueFallbackUpdate(
    update: FallbackUpdate,
    key: string,
    priority = false,
  ) {
    if (this.fallbackQueuedKeys.has(key)) return;
    this.fallbackQueuedKeys.add(key);
    const item = { key, update };
    if (priority) this.fallbackQueue.unshift(item);
    else this.fallbackQueue.push(item);
    this.scheduleFallbackQueue(0);
  }

  private scheduleFallbackQueue(delay: number) {
    if (this.stopped || this.fallbackQueueTimer !== null) return;
    this.fallbackQueueTimer = window.setTimeout(
      () => void this.flushFallbackQueue(),
      delay,
    );
  }

  private async flushFallbackQueue() {
    this.fallbackQueueTimer = null;
    const item = this.fallbackQueue.shift();
    if (!item) return;
    this.fallbackQueuedKeys.delete(item.key);

    try {
      await Promise.resolve(
        window.webxdc.sendUpdate({ payload: item.update }, ""),
      );
      if (item.update.type === "chunk") {
        await this.addSentBytes(
          item.update.file,
          base64ToByteLength(item.update.data),
        );
      }
    } catch (error) {
      console.error("failed to send fallback update", error);
    }

    if (this.fallbackQueue.length > 0) {
      this.scheduleFallbackQueue(getFallbackSendInterval());
    }
  }
}

function getRandomUUID(): string {
  try {
    return crypto.randomUUID();
  } catch (ex) {
    const s4 = () => {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
    };
    return (
      s4() +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      s4() +
      s4()
    );
  }
}

function getChunkCount(size: number): number {
  return size > 0 ? Math.ceil(size / CHUNK_SIZE) : 0;
}

function createPendingChunks(size: number): number[] {
  return Array.from({ length: getChunkCount(size) }, (_value, index) => index);
}

function getChunkKey(
  file: string,
  lastModified: number,
  chunk: number,
): string {
  return `${file}:${lastModified}:${chunk}`;
}

function toAnnouncement(file: FileMeta): FileAnnouncement {
  return {
    id: file.id,
    name: file.name,
    lastModified: file.lastModified,
    size: file.size,
    type: file.type,
  };
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = await blobToUint8Array(blob);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function getFallbackSendInterval(): number {
  const value = window.webxdc.sendUpdateInterval;
  return typeof value === "number" && value > 0
    ? value
    : FALLBACK_DEFAULT_SEND_INTERVAL;
}

function isFallbackUpdate(payload: unknown): payload is FallbackUpdate {
  if (!payload || typeof payload !== "object") return false;
  const update = payload as Partial<FallbackUpdate>;
  return (
    update.v === 1 &&
    (update.type === "file-meta" ||
      update.type === "chunk-request" ||
      update.type === "chunk") &&
    typeof update.sender === "string"
  );
}
