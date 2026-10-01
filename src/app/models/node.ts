import { NodeType } from "./nodeType";
import { ViewMode } from "./viewMode";

/// Separator of the levels in the heading ("Series › Season 2"). The
/// character is bidi-mirrored, so it points the right way in RTL too.
export const NODE_PATH_SEPARATOR = " › ";

export class Node {
  readonly id: number;
  readonly name: string;
  readonly type: NodeType;
  /// Names from the top level down to this node, for the heading.
  readonly path: readonly string[];
  /// Scroll position of the level this node was opened from, restored when
  /// going back to it.
  readonly scrollPosition: number;
  query?: string;
  /// Pages the level this node was opened from had loaded: going back loads
  /// as many again, so the scroll position exists.
  page?: number;
  /// Index of the tile that had the keyboard focus when the node was opened.
  tileIndex?: number;
  fromViewType?: ViewMode;

  constructor(
    id: number,
    name: string,
    type: NodeType,
    query?: string,
    fromViewType?: ViewMode,
    parent?: Node,
  ) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.query = query;
    this.scrollPosition = window.scrollY;
    this.fromViewType = fromViewType;
    this.path = [...(parent?.path ?? []), name];
  }

  /** "Series › Season 2": the path for the heading (translated around it). */
  pathLabel(): string {
    return this.path.join(NODE_PATH_SEPARATOR);
  }
}
