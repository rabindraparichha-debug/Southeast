'use client';

import { useState } from 'react';
import type { ColumnMapping } from '@tiffin/core';
import { Button } from '@/components/ui';
import { ImportWizard, type Sheet } from './import-wizard';
import { NotebookImport } from './notebook-import';

// Two ways in (spreadsheet file, or a photo of the paper notebook), one way to save: the import wizard.
export function ImportArea({ kitchenId, planNames }: { kitchenId: string; planNames: string[] }) {
  const [preset, setPreset] = useState<{ sheet: Sheet; mapping: ColumnMapping } | null>(null);
  return (
    <div className="space-y-6">
      {preset ? (
        <>
          <Button variant="ghost" onClick={() => setPreset(null)}>← Back to the notebook rows</Button>
          <ImportWizard key={preset.sheet.rows.length + preset.sheet.fileName} kitchenId={kitchenId} planNames={planNames} initial={preset} />
        </>
      ) : (
        <ImportWizard kitchenId={kitchenId} planNames={planNames} />
      )}
      {/* Kept mounted while importing so "Back" returns to the corrected rows. */}
      <div className={preset ? 'hidden' : undefined}>
        <NotebookImport kitchenId={kitchenId} planNames={planNames} onConfirm={setPreset} />
      </div>
    </div>
  );
}
