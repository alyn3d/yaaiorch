// Desktop notifications: the Tauri notification plugin in the desktop app, the browser's Notification API in
// browser mode. Off until the user turns them on (the browser asks for permission then).
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isTauri } from "./transport";

const KEY = "yaaiorch.notify";

export function notifyOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

async function permitted(ask: boolean): Promise<boolean> {
  if (isTauri) return (await isPermissionGranted()) || (ask && (await requestPermission()) === "granted");
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  return ask && Notification.permission !== "denied" && (await Notification.requestPermission()) === "granted";
}

/** Turn notifications on or off; returns whether they are on (permission can be refused). */
export async function setNotifyOn(on: boolean): Promise<boolean> {
  const ok = on && (await permitted(true));
  try {
    localStorage.setItem(KEY, ok ? "1" : "0");
  } catch {
    /* storage blocked: on for this page only */
  }
  return ok;
}

/** Show one, if they are on and the window is not what the user is looking at. */
export async function notify(n: { title: string; body: string }) {
  if (!notifyOn() || (!document.hidden && document.hasFocus())) return;
  try {
    if (!(await permitted(false))) return;
    if (isTauri) sendNotification(n);
    else new Notification(n.title, { body: n.body, icon: "/logo-64.png" });
  } catch {
    /* a notification is never worth an error */
  }
}
