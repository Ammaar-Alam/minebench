import { permanentRedirect } from "next/navigation";

export default function GalleryYoursPage() {
  permanentRedirect("/account#builds");
}
