import { redirect } from "next/navigation";
import { connection } from "next/server";

/**
 * The bare domain. A public demo (PUBLIC_DEMO=1) opens on the landing page, so visitors get
 * the intro first; a local or team setup goes straight to the canvas.
 */
export default async function Page() {
  // Read the environment at request time, not when the page is prerendered at build.
  await connection();
  const publicDemo = process.env.PUBLIC_DEMO === "1" || process.env.PUBLIC_DEMO === "true";
  redirect(publicDemo ? "/welcome" : "/canvas");
}
