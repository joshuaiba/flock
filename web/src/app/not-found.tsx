import Link from "next/link";
import { Empty } from "@/components/Empty";

export default function NotFound() {
  return (
    <main className="grid min-h-[80svh] place-items-center pt-20">
      <Empty title="This page flew off">
        <Link href="/">Back to the field</Link>
      </Empty>
    </main>
  );
}
