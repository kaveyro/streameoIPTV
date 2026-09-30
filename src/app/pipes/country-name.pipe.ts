import { Pipe, PipeTransform } from "@angular/core";
import { CountryPrefixMode, displayName } from "../country-prefix";

/** `{{ channel.name | countryName: memory.CountryPrefixMode }}`: the name with
 *  its country prefix shown or dropped, see {@link displayName}. */
@Pipe({
  name: "countryName",
})
export class CountryNamePipe implements PipeTransform {
  transform(name: string | undefined | null, mode: CountryPrefixMode): string {
    return displayName(name, mode);
  }
}
