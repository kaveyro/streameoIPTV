/** What a saved guide search does with the programmes it finds. */
export type EpgAlertAction = "remind" | "record";

/**
 * A saved guide search: every upcoming XMLTV programme whose title contains
 * `query` gets a reminder or a scheduled recording, also the ones added by
 * later guide refreshes.
 */
export interface EpgAlert {
  id: number;
  query: string;
  action: EpgAlertAction;
  /// Unix seconds.
  created: number;
}

/// The backend ignores shorter queries.
export const EPG_ALERT_MIN_LENGTH = 2;

/** The alert with the same query (case-insensitive) and action, if any. */
export function findEpgAlert(
  alerts: EpgAlert[],
  query: string,
  action: EpgAlertAction,
): EpgAlert | undefined {
  const term = query.trim().toLocaleLowerCase();
  return alerts.find((a) => a.action === action && a.query.trim().toLocaleLowerCase() === term);
}
