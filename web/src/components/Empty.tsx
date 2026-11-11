import { PaintedBird } from "./Icon";

/** Empty and error states: one lone swallow looking for its flock. */
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="relative z-20 mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <PaintedBird award={false} angle={-0.5} flap={0.8} size={56} />
      <h2 className="mt-3 text-3xl">{title}</h2>
      {children && <p className="mt-3 text-muted">{children}</p>}
    </div>
  );
}
