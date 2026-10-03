import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { provideHttpClient } from "@angular/common/http";
import { TranslatePipe, provideTranslateService } from "@ngx-translate/core";
import { provideTranslateHttpLoader } from "@ngx-translate/http-loader";
import { AppRoutingModule } from "./app-routing.module";
import { AppComponent } from "./app.component";
import { NgbModalModule, NgbTooltipModule, NgbTypeaheadModule } from "@ng-bootstrap/ng-bootstrap";
import { FormsModule } from "@angular/forms";
import { MatMenuModule } from "@angular/material/menu";
import { DragDropModule } from "@angular/cdk/drag-drop";
import { KeyboardShortcutsModule } from "ng-keyboard-shortcuts";
import { ToastrModule } from "ngx-toastr";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { ErrorModalComponent } from "./error-modal/error-modal.component";
import { EditChannelModalComponent } from "./edit-channel-modal/edit-channel-modal.component";
import { EditGroupModalComponent } from "./edit-group-modal/edit-group-modal.component";
import { GroupNameExistsValidator } from "./edit-group-modal/validators/group-name-exists.directive";
import { DeleteGroupModalComponent } from "./delete-group-modal/delete-group-modal.component";
import { ImportModalComponent } from "./import-modal/import-modal.component";
import { ConfirmDeleteModalComponent } from "./confirm-delete-modal/confirm-delete-modal.component";
import { EpgModalComponent } from "./epg-modal/epg-modal.component";
import { EpgModalItemComponent } from "./epg-modal/epg-modal-item/epg-modal-item.component";
import { EpgMappingModalComponent } from "./epg-mapping-modal/epg-mapping-modal.component";
import { RestreamModalComponent } from "./restream-modal/restream-modal.component";
import { DownloadManagerComponent } from "./download-manager/download-manager.component";
import { PlayerComponent } from "./player/player.component";
import { UpdateModalComponent } from "./update-modal/update-modal.component";
import { PinDialogComponent } from "./pin-dialog/pin-dialog.component";
import { FavoriteListNameModalComponent } from "./favorite-lists/favorite-list-name-modal/favorite-list-name-modal.component";
import { TimeAgoPipe } from "./pipes/time-ago.pipe";
import { CountryNamePipe } from "./pipes/country-name.pipe";
import { AppToastComponent } from "./app-toast/app-toast.component";

@NgModule({
  declarations: [
    AppComponent,
    ErrorModalComponent,
    EditChannelModalComponent,
    EditGroupModalComponent,
    GroupNameExistsValidator,
    DeleteGroupModalComponent,
    ImportModalComponent,
    ConfirmDeleteModalComponent,
    EpgModalComponent,
    EpgModalItemComponent,
    EpgMappingModalComponent,
    RestreamModalComponent,
    DownloadManagerComponent,
    UpdateModalComponent,
    PlayerComponent,
    PinDialogComponent,
    FavoriteListNameModalComponent,
  ],
  imports: [
    BrowserModule,
    FormsModule,
    BrowserAnimationsModule,
    AppRoutingModule,
    NgbTooltipModule,
    ToastrModule.forRoot({
      // Top right: the embedded player's native mpv window covers the whole
      // video area and always composites above the WebView, so a toast in the
      // bottom-left corner was painted underneath it and never seen.
      positionClass: "toast-top-right",
      timeOut: 4000,
      progressBar: true,
      closeButton: true,
      newestOnTop: true,
      preventDuplicates: true,
      maxOpened: 4,
      // Translated close label, focus pauses the timeout, and error toasts
      // get a "Details" button instead of only a click on the toast.
      toastComponent: AppToastComponent,
    }),
    KeyboardShortcutsModule.forRoot(),
    MatMenuModule,
    DragDropModule,
    NgbModalModule,
    NgbTypeaheadModule,
    TranslatePipe,
    // Standalone pipes still used by the components declared here.
    TimeAgoPipe,
    CountryNamePipe,
  ],
  providers: [
    provideAnimationsAsync(),
    provideHttpClient(),
    provideTranslateService({
      fallbackLang: "en",
      loader: provideTranslateHttpLoader({ prefix: "./assets/i18n/", suffix: ".json" }),
    }),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
