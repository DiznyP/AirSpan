import { createFileRoute } from "@tanstack/react-router";
import { DisplayReceiver } from "../display-receiver";

export const Route = createFileRoute("/display/$code")({
  component: DisplayRoute,
});

function DisplayRoute() {
  const { code } = Route.useParams();

  return <DisplayReceiver code={code} />;
}