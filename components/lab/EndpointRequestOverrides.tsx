"use client";

import { useState } from "react";
import {
  RequestOverridesEditor,
  type RequestOverridesProfile,
} from "@/components/generation/RequestOverridesEditor";

const EMPTY_PROFILE: RequestOverridesProfile = { headers: [], body: [] };

export function EndpointRequestOverrides() {
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  return (
    <div className="border-t border-border/60 pt-2 sm:col-span-2">
      <input type="hidden" name="requestHeaders" value={JSON.stringify(profile.headers)} />
      <input type="hidden" name="requestBody" value={JSON.stringify(profile.body)} />
      <RequestOverridesEditor profile={profile} onChange={setProfile} />
    </div>
  );
}
