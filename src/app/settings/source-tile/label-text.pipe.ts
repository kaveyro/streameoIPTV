import { Pipe, PipeTransform } from "@angular/core";

/**
 * A visible label ("URL:", "Max. streams :", "用户代理：") without its trailing
 * colon, for an aria-label: screen readers would otherwise read it out.
 */
@Pipe({ name: "labelText" })
export class LabelTextPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return (value ?? "").replace(/\s*[:：]\s*$/, "");
  }
}
