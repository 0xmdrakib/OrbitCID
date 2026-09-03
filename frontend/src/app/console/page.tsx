import type { Metadata } from "next";
import { ConsoleApp } from "@/components/console-app";

export const metadata: Metadata = { title: "Console", robots: { index: false, follow: false } };
export default function ConsolePage() { return <ConsoleApp/>; }
