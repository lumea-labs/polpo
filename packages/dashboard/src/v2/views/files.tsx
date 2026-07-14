"use client";

import { useDashboardHost } from "../../host.js";
import { FilesBrowser } from "../files/files-browser.js";
import { PageBody } from "../files/host.js";

export function FilesView() {
  const { project } = useDashboardHost();
  return (
    <PageBody>
      <FilesBrowser projectId={project.id} />
    </PageBody>
  );
}
