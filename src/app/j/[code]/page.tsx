import { Suspense } from "react";
import { PhoneApp } from "@/components/phone/PhoneApp";
import { Spinner } from "@/components/ui";

export default function PhonePage() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
      <PhoneApp />
    </Suspense>
  );
}
