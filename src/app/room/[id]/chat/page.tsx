export const instant = false;

import ChatClient from "./chat-client";

export default async function Page({ params }: PageProps<"/room/[id]/chat">) {
  const { id } = await params;
  return <ChatClient roomId={id} />;
}
