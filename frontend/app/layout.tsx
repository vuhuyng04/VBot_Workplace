import type { Metadata, Viewport } from "next";
import { Be_Vietnam_Pro, Montserrat } from "next/font/google";
import "./globals.css";

const text = Be_Vietnam_Pro({ subsets: ["latin", "vietnamese"], weight: ["400", "500", "600", "700"], variable: "--font-text", display: "swap" });
const head = Montserrat({ subsets: ["latin", "vietnamese"], weight: ["600", "700", "800"], variable: "--font-head", display: "swap" });

export const metadata: Metadata = {
  title: "VBot Workplace",
  description: "Trợ lý AI nội bộ: chat, workspace tài liệu, sandbox code, agent dự án và minh bạch chi phí.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#002147" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${text.variable} ${head.variable}`}>
      <body className="anon">{children}</body>
    </html>
  );
}
