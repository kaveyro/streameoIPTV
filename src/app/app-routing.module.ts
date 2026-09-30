import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { HomeComponent } from "./home/home.component";

export const routes: Routes = [
  // The start page stays in the initial bundle; setup and settings are only
  // needed on demand and load as separate chunks.
  { path: "", component: HomeComponent },
  {
    path: "setup",
    loadComponent: () => import("./setup/setup.component").then((m) => m.SetupComponent),
  },
  {
    path: "settings",
    loadComponent: () => import("./settings/settings.component").then((m) => m.SettingsComponent),
  },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
