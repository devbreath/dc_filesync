import { useEffect, useState, useMemo } from "react";

import { FileManager } from "~/lib/filemanager";
import { Peer } from "@webxdc/realtime";

import FileList from "~/components/FileList";
import Footer from "~/components/Footer";
import FilePicker from "~/components/FilePicker";
import FilePreview from "~/components/FilePreview";

import "./App.css";

export default function App() {
  const [peers, setPeers] = useState<Peer<State>[]>([]);
  const [previewFile, setPreviewFile] = useState<FileMeta | null>(null);
  let [files, setFiles] = useState<FileMeta[] | null>(
    null as FileMeta[] | null,
  );
  const [manager] = useState(() => {
    return new FileManager(setPeers, setFiles);
  });

  useEffect(() => {
    void manager.start();
    return () => manager.stop();
  }, [manager]);

  if (!files) return null;

  const FilePickerM = useMemo(
    () => <FilePicker manager={manager} />,
    [manager],
  );
  const FileListM = useMemo(
    () => (
      <FileList files={files} manager={manager} onPreview={setPreviewFile} />
    ),
    [files, manager],
  );
  const size = files.reduce((acc, file) => acc + file.size, 0);
  const FooterM = useMemo(
    () => (
      <Footer
        totalSize={size}
        fileCount={files.length}
        peerCount={peers.length}
      />
    ),
    [files.length, size, peers.length],
  );

  return (
    <div style={{ padding: "1em" }}>
      {FilePickerM}
      {FileListM}
      {FooterM}
      {previewFile && (
        <FilePreview
          file={previewFile}
          manager={manager}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
