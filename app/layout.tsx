import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Buzz Web — 브라우저용 Buzz 클라이언트",
  description: "설치 없이 Buzz relay의 채널을 읽고 메시지를 보내는 가벼운 웹 클라이언트입니다.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
