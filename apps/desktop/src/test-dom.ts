/**
 * A DOM for `bun test`, loaded through `preload` in bunfig.toml.
 *
 * Bun runs tests in bare JavaScript, with no `window` and no `localStorage`.
 * Mantine's `useLocalStorage` touches both the moment it renders, so anything
 * built on it — `useDraft`, and so every composer and editor in the app — can
 * only be rendered in a test once a DOM exists. happy-dom is that DOM.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "https://desktop.berdloop.test/" });
}
