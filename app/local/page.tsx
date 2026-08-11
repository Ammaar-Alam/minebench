import { redirect } from "next/navigation";

export default function LocalLabPage() {
  redirect("/sandbox?mode=import");
}
