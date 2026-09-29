/**
 * Shared unit test setup: the modules and providers the components expect
 * from AppModule, and a mock of the Tauri IPC bridge (there is no Rust
 * backend in Karma).
 */
import { Component, NgModule } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { FormsModule } from "@angular/forms";
import { MatMenuModule } from "@angular/material/menu";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { provideRouter } from "@angular/router";
import {
  NgbActiveModal,
  NgbModalModule,
  NgbTooltipModule,
  NgbTypeaheadModule,
} from "@ng-bootstrap/ng-bootstrap";
import { TranslatePipe, provideTranslateService } from "@ngx-translate/core";
import { ToastrModule } from "ngx-toastr";
import { KeyboardShortcutsModule } from "ng-keyboard-shortcuts";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { TimeAgoPipe } from "../app/pipes/time-ago.pipe";
import { NotEmptyValidatorDirective } from "../app/setup/validators/not-empty-validator.directive";
import { SourceNameExistsValidator } from "../app/setup/validators/source-name-exists-validator.directive";
import { GroupNameExistsValidator } from "../app/edit-group-modal/validators/group-name-exists.directive";

/// Navigation target for every route in tests.
@Component({ standalone: true, template: "" })
export class BlankTestComponent {}

/// ngx-translate 18 has no TranslateModule any more; this bundles the pipe
/// with the service so specs get both from TEST_IMPORTS alone.
@NgModule({
  imports: [TranslatePipe],
  exports: [TranslatePipe],
  providers: [provideTranslateService()],
})
export class TestTranslateModule {}

/// Modules AppModule imports (without the HTTP translation loader: the
/// TranslatePipe then renders the keys themselves).
export const TEST_IMPORTS = [
  FormsModule,
  NoopAnimationsModule,
  TestTranslateModule,
  ToastrModule.forRoot(),
  MatMenuModule,
  NgbTooltipModule,
  NgbTypeaheadModule,
  NgbModalModule,
  KeyboardShortcutsModule.forRoot(),
];

/// Pipes and directives shared by several templates.
export const SHARED_DECLARATIONS = [
  TimeAgoPipe,
  NotEmptyValidatorDirective,
  SourceNameExistsValidator,
  GroupNameExistsValidator,
];

export const TEST_PROVIDERS = [provideRouter([{ path: "**", component: BlankTestComponent }])];

export function activeModalStub(): jasmine.SpyObj<NgbActiveModal> {
  return jasmine.createSpyObj<NgbActiveModal>("NgbActiveModal", ["close", "dismiss"]);
}

export interface IpcCall {
  cmd: string;
  args: Record<string, unknown>;
}

type Handler = unknown | ((args: Record<string, unknown>) => unknown);

/// What the backend answers when a test does not say otherwise.
const DEFAULTS: Record<string, unknown> = {
  is_container: false,
  get_settings: {},
  get_sources: [],
  get_enabled_sources: [],
  get_xmltv_sources: [],
  get_all_expiries: {},
  get_epg_ids: [],
  get_epg: [],
  get_scheduled_recordings: [],
  get_recording_schedule: [],
  get_recording_files: [],
  get_recording_folder: "C:\\Recordings",
  has_parental_pin: false,
  get_locked_group_ids: [],
  get_countries: [],
  has_xmltv_data: false,
  search: [],
  group_auto_complete: [],
  get_network_info: { port: 3000, local_ips: ["192.168.1.2"], wan_ip: "203.0.113.1" },
  "plugin:app|version": "0.0.0-test",
};

/**
 * Mocks the Tauri IPC bridge. `handlers` override the default answers per
 * command (a value, or a function of the arguments; a thrown error or a
 * rejected promise becomes a failed command). Returns the recorded calls.
 * Call {@link resetTauri} in afterEach.
 */
export function mockTauri(handlers: Record<string, Handler> = {}): IpcCall[] {
  const calls: IpcCall[] = [];
  mockWindows("main");
  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      const handler = cmd in handlers ? handlers[cmd] : DEFAULTS[cmd];
      return typeof handler === "function"
        ? (handler as (a: Record<string, unknown>) => unknown)(args)
        : (handler ?? null);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

/**
 * Destroys the components first (they unlisten Tauri events on destroy, which
 * needs the mocks), then removes the mocks.
 */
export function resetTauri() {
  TestBed.resetTestingModule();
  clearMocks();
}

/** The recorded calls of one command. */
export function callsOf(calls: IpcCall[], cmd: string): IpcCall[] {
  return calls.filter((c) => c.cmd === cmd);
}

/** Lets pending promises (mocked IPC answers) settle. */
export async function settle(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
