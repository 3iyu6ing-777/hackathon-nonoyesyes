export const instant = false;

import RoomClient from "./room-client";

export default async function Page({ params }: PageProps<"/room/[id]">) {
  const { id } = await params;
  return <RoomClient roomId={id} />;
}
