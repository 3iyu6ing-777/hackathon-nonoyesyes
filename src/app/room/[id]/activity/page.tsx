export const instant = false;

import ActivityClient from "./activity-client";

export default async function Page({ params }: PageProps<"/room/[id]/activity">) {
  const { id } = await params;
  return <ActivityClient roomId={id} />;
}
