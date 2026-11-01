/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { useState } from "@webpack/common";

import { exportConversationJson } from "../export/json";

export function ExportButton() {
    const [running, setRunning] = useState(false);

    return (
        <Button
            variant="secondary"
            disabled={running}
            onClick={async () => {
                setRunning(true);
                try {
                    await exportConversationJson();
                } finally {
                    setRunning(false);
                }
            }}
        >
            {running ? "Exporting..." : "Export current conversation (JSON)"}
        </Button>
    );
}
