import { SwallowVignette } from "./Art";

/** Empty and error states: the swallow on a broken column, beside a short
 *  message. Side by side when its container is wide enough, stacked when not. */
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="@container mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
      <div className="mx-auto flex w-fit max-w-full flex-col items-center gap-5 text-center @xl:flex-row @xl:gap-10 @xl:text-left">
        <SwallowVignette width={280} className="max-w-[70cqw]" />
        <div className="max-w-sm">
          <h2 className="text-[2rem] leading-[1.1]">{title}</h2>
          {children && <p className="lede mt-3">{children}</p>}
        </div>
      </div>
    </div>
  );
}
