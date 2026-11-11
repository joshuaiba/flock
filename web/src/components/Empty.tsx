import { SwallowVignette } from "./Art";

/** Empty and error states: a swallow on a broken column, beside a short
 *  message. Side by side when its container is wide enough, stacked when not. */
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="@container relative z-20 mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
      <div className="mx-auto flex w-fit max-w-full flex-col items-center gap-5 text-center @xl:flex-row @xl:gap-10 @xl:text-left">
        <SwallowVignette width={280} className="max-w-[70cqw]" />
        <div className="max-w-sm">
          <h2 className="text-3xl">{title}</h2>
          {children && <p className="mt-3 text-muted">{children}</p>}
        </div>
      </div>
    </div>
  );
}
