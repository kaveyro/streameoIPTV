export enum RecordingStatus {
  Pending = 0,
  Recording = 1,
  Done = 2,
  Failed = 3,
}

export interface ScheduledRecording {
  id: number;
  channel_id: number;
  title?: string;
  start_timestamp: number;
  end_timestamp: number;
  status: RecordingStatus;
  /// Only filled by get_recording_schedule / get_scheduled_recordings.
  channel_name?: string;
}
