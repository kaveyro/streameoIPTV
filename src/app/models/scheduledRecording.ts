export interface ScheduledRecording {
  id: number;
  channel_id: number;
  title?: string;
  start_timestamp: number;
  end_timestamp: number;
  status: number;
}
