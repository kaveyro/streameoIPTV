/// <reference types="@angular/localize" />

import { provideZoneChangeDetection } from "@angular/core";
import { platformBrowserDynamic } from "@angular/platform-browser-dynamic";

import { AppModule } from "./app/app.module";
import { applyCachedTheme } from "./app/theme-cache";

// Before the bootstrap: the stored settings are only read once Angular runs,
// and the dark default would flash for light-theme users meanwhile.
applyCachedTheme();

platformBrowserDynamic()
  .bootstrapModule(AppModule, { applicationProviders: [provideZoneChangeDetection()] })
  .catch((err) => console.error(err));
