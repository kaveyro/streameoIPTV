export class NetworkInfo {
  port!: number;
  local_ips!: Array<string>;
  /// Empty when the public address cannot be determined.
  wan_ip!: string;
}
