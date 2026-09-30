import { Node } from "./node";

export class Stack {
  private nodes: Node[] = [];

  add(node: Node): void {
    this.nodes.push(node);
  }

  pop(): Node {
    if (this.nodes.length === 0) {
      throw new Error("Stack is empty");
    }
    return this.nodes.pop()!;
  }

  get(): Node | undefined {
    return this.nodes[this.nodes.length - 1];
  }

  /** The innermost node of the given type. */
  findLast(type: Node["type"]): Node | undefined {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      if (this.nodes[i].type === type) return this.nodes[i];
    }
    return undefined;
  }

  hasNodes(): boolean {
    return this.nodes.length > 0;
  }

  clear(): Node | undefined {
    const first = this.nodes[0];
    this.nodes = [];
    return first;
  }
}
