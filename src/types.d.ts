declare type Payload =
  | {
      request: PeerRequest;
    }
  | {
      response: PeerResponse;
    };

declare interface PeerRequest {
  time: number;
  file: string;
  lastModified: number;
  chunk: number;
  peer: string;
}

declare interface PeerResponse {
  file: string;
  lastModified: number;
  chunk: number;
  data: Uint8Array;
}

declare interface FileMeta {
  id: string;
  pending: number[];
  name: string;
  lastModified: number;
  size: number;
  type: string;
  sentBytes: number;
  sentChunks: number[];
  retransmitCount: number;
  retransmitBytes: number;
}

declare interface Chunk {
  file: string;
  id: number;
  blob: Blob;
}

declare interface State {
  files: FileMeta[];
}

declare interface FileAnnouncement {
  id: string;
  name: string;
  lastModified: number;
  size: number;
  type: string;
}

declare type FallbackUpdate =
  | {
      v: 1;
      type: "file-meta";
      sender: string;
      file: FileAnnouncement;
    }
  | FallbackChunkRequest
  | {
      v: 1;
      type: "chunk";
      sender: string;
      file: string;
      lastModified: number;
      chunk: number;
      data: string;
      meta?: FileAnnouncement;
    };

declare interface FallbackChunkRequest {
  v: 1;
  type: "chunk-request";
  sender: string;
  file: string;
  lastModified: number;
  chunks: number[];
}
