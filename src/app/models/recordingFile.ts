/// A finished recording in the recording folder (see recordings.rs).
export interface RecordingFile {
  path: string;
  name: string;
  /// Bytes.
  size: number;
  /// Unix seconds.
  modified: number;
}
