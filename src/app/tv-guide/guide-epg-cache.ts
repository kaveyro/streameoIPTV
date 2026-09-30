import { Injectable } from "@angular/core";
import { EPG } from "../models/epg";

/// Session cache of the guide data per channel id, kept when the guide closes.
/// In its own file so services can use it without pulling the (lazy loaded)
/// guide component into the initial bundle.
@Injectable({ providedIn: "root" })
export class GuideEpgCache {
  readonly entries: Map<number, EPG[]> = new Map();
}
