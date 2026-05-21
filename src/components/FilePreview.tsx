import { useEffect, useMemo, useState } from "react";

import MageX from "~icons/mage/x";

import { FileManager } from "~/lib/filemanager";
import { formatBytes } from "~/lib/util";

interface Props {
  file: FileMeta;
  manager: FileManager;
  onClose: () => void;
}

type PreviewState =
  | {
      loading: true;
    }
  | {
      loading: false;
      url: string;
      text: string | null;
      error: null;
    }
  | {
      loading: false;
      url: null;
      text: null;
      error: string;
    };

export default function FilePreview({ file, manager, onClose }: Props) {
  const [preview, setPreview] = useState<PreviewState>({ loading: true });

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    setPreview({ loading: true });
    void manager
      .getFileBlob(file)
      .then(async (blob) => {
        objectUrl = URL.createObjectURL(blob);
        const text = canPreviewAsText(file) ? await blob.text() : null;
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPreview({
          loading: false,
          url: objectUrl,
          text,
          error: null,
        });
      })
      .catch((error) => {
        if (!active) return;
        setPreview({
          loading: false,
          url: null,
          text: null,
          error:
            error instanceof Error
              ? error.message
              : "Preview is not available.",
        });
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, manager]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const content = useMemo(() => {
    if (preview.loading) {
      return <p style={messageStyle}>Loading...</p>;
    }
    if (preview.error) {
      return <p style={messageStyle}>{preview.error}</p>;
    }
    if (preview.text !== null) {
      return <pre style={textPreviewStyle}>{preview.text}</pre>;
    }
    if (!preview.url) {
      return <p style={messageStyle}>Preview is not available.</p>;
    }
    const url = preview.url;
    if (canPreviewAsImage(file)) {
      return <img alt={file.name} src={url} style={mediaStyle} />;
    }
    if (canPreviewAsVideo(file)) {
      return <video controls src={url} style={mediaStyle} />;
    }
    if (canPreviewAsAudio(file)) {
      return <audio controls src={url} style={{ width: "100%" }} />;
    }
    if (canPreviewAsPdf(file)) {
      return <iframe src={url} style={frameStyle} title={file.name} />;
    }
    return <p style={messageStyle}>Preview is not available.</p>;
  }, [file, preview]);

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        style={modalStyle}
      >
        <header style={headerStyle}>
          <div style={titleWrapStyle}>
            <strong style={titleStyle}>{file.name}</strong>
            <small style={subTitleStyle}>{formatBytes(file.size)}</small>
          </div>
          <button
            aria-label="Close preview"
            onClick={onClose}
            style={closeStyle}
          >
            <MageX style={{ fontSize: "1.6em" }} />
          </button>
        </header>
        <div style={bodyStyle}>{content}</div>
      </div>
    </div>
  );
}

const overlayStyle = {
  alignItems: "center",
  background: "rgba(0, 0, 0, 0.45)",
  bottom: 0,
  display: "flex",
  justifyContent: "center",
  left: 0,
  padding: "1em",
  position: "fixed" as "fixed",
  right: 0,
  top: 0,
  zIndex: 10,
};

const modalStyle = {
  background: "white",
  borderRadius: "8px",
  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.24)",
  display: "flex",
  flexDirection: "column" as "column",
  maxHeight: "92vh",
  maxWidth: "980px",
  overflow: "hidden",
  width: "100%",
};

const headerStyle = {
  alignItems: "center",
  borderBottom: "1px solid #e0e0e0",
  display: "flex",
  gap: "1em",
  justifyContent: "space-between",
  padding: "0.75em 1em",
};

const titleWrapStyle = {
  display: "flex",
  flexDirection: "column" as "column",
  minWidth: 0,
};

const titleStyle = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as "nowrap",
};

const subTitleStyle = {
  color: "#737373",
};

const closeStyle = {
  alignItems: "center",
  background: "#f0f0f0",
  border: "none",
  borderRadius: "5px",
  color: "#333",
  cursor: "pointer",
  display: "flex",
  flexShrink: 0,
  height: "2.4em",
  justifyContent: "center",
  width: "2.4em",
};

const bodyStyle = {
  alignItems: "center",
  display: "flex",
  justifyContent: "center",
  minHeight: "16em",
  overflow: "auto",
  padding: "1em",
};

const mediaStyle = {
  maxHeight: "72vh",
  maxWidth: "100%",
};

const frameStyle = {
  border: "none",
  height: "72vh",
  width: "100%",
};

const textPreviewStyle = {
  boxSizing: "border-box" as "border-box",
  margin: 0,
  maxHeight: "72vh",
  overflow: "auto",
  whiteSpace: "pre-wrap" as "pre-wrap",
  width: "100%",
};

const messageStyle = {
  color: "#737373",
  margin: 0,
  textAlign: "center" as "center",
};

function canPreviewAsImage(file: FileMeta): boolean {
  return file.type.startsWith("image/") || hasExtension(file.name, imageExts);
}

function canPreviewAsVideo(file: FileMeta): boolean {
  return file.type.startsWith("video/") || hasExtension(file.name, videoExts);
}

function canPreviewAsAudio(file: FileMeta): boolean {
  return file.type.startsWith("audio/") || hasExtension(file.name, audioExts);
}

function canPreviewAsPdf(file: FileMeta): boolean {
  return file.type === "application/pdf" || hasExtension(file.name, [".pdf"]);
}

function canPreviewAsText(file: FileMeta): boolean {
  return (
    file.type.startsWith("text/") ||
    textTypes.includes(file.type) ||
    hasExtension(file.name, textExts)
  );
}

function hasExtension(fileName: string, extensions: string[]): boolean {
  const lowerName = fileName.toLowerCase();
  return extensions.some((extension) => lowerName.endsWith(extension));
}

const imageExts = [
  ".avif",
  ".bmp",
  ".gif",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp",
];
const videoExts = [".m4v", ".mov", ".mp4", ".ogg", ".ogv", ".webm"];
const audioExts = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
];
const textExts = [
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".log",
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
];
const textTypes = [
  "application/javascript",
  "application/json",
  "application/xml",
];
