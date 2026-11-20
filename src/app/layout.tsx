import type { Metadata } from "next";
import SettingsPanel from "@/components/settings-panel";
import "./globals.css";

export const metadata: Metadata = {
  title: "MeetMate",
  description: "把群里的 200 条消息，变成一个大家都接受的地方。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <SettingsPanel />
      </body>
    </html>
  );
}
