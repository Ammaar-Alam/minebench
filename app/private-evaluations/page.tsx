import { permanentRedirect } from "next/navigation";

export default function PrivateEvaluationsPage() {
  permanentRedirect("/faq#can-organizations-run-private-evaluations");
}
