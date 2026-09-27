// Opens Gradescope and Ed in their built-in windows, on the site the user's school uses.
import { invoke } from "./bridge";
import { edHome } from "./ed";
import { gradescopeHome } from "./gradescope";
import { getSources } from "./store";

/** Opens a page, or the service's home page for the connected school. */
export async function openService(name: "gradescope" | "ed", url?: string): Promise<void> {
  if (!url) {
    const source = (await getSources()).find((s) => s.kind === name);
    url = name === "gradescope" ? gradescopeHome(source?.site) : edHome(source?.region);
  }
  await invoke("open_service", { name, url });
}
