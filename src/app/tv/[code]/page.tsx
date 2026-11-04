import { Suspense } from "react";
import { TvApp } from "@/components/tv/TvApp";
import { Spinner } from "@/components/ui";

export default function TvPage() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
      <TvApp />
    </Suspense>
  );
}
