import Link from "next/link";
import { Empty } from "@/components/Empty";

export default function NotFound() {
  return (
    <main className="pt-24">
      <Empty title="This page flew off">
        <Link href="/">Back to the field</Link>
      </Empty>
    </main>
  );
}
