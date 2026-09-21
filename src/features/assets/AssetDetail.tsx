import { useEffect, useRef, useState } from 'react';
import { getAsset, updateAsset } from '@/api/client';
import { isAbortError, toApiError } from '@/api/errors';
import { describeError } from '@/lib/errorCopy';
import { formatBytes, formatDate, formatDuration, statusLabel } from '@/lib/format';
import type { Asset, AssetStatus } from '@/lib/types';
import { STATUSES } from '@/lib/viewQuery';
import { StatusGlyph } from '@/components/StatusBadge';
import { type AssetStore, useAssetView, useWriteState } from './assetStore';
import { Thumbnail } from './Thumbnail';

interface Props {
  id: string;
  assets: AssetStore;
  onClose: () => void;
}

interface Conflict {
  mine: AssetStatus;
  theirs: AssetStatus;
}

export function AssetDetail({ id, assets, onClose }: Props) {
  const [loaded, setLoaded] = useState<Asset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Opening (or switching) moves focus into the panel. It is not modal, so
  // there is no trap: Tab carries on past it, and Escape closes it (App).
  useEffect(() => {
    panelRef.current?.focus();
  }, [id]);

  useEffect(() => {
    // Opening A then B quickly must not let A's slower response land in B's panel.
    const controller = new AbortController();
    setLoaded(null);
    setLoadError(null);
    getAsset(id, controller.signal).then(
      (asset) => {
        // The freshest copy we have: record it, so the card in the grid updates too.
        assets.confirm(asset);
        setLoaded(asset);
      },
      (err: unknown) => {
        if (!isAbortError(err)) setLoadError(describeError(toApiError(err)).title);
      },
    );
    return () => controller.abort();
  }, [id, assets]);

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className="panel"
      aria-labelledby="detail-title detail-name"
    >
      <div className="panel__head">
        <h2 id="detail-title">Asset detail</h2>
        <button type="button" className="button button--quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {!loaded && !loadError && <p className="state__detail">Loading…</p>}
      {loaded && <DetailBody key={loaded.id} source={loaded} assets={assets} />}
    </aside>
  );
}

function DetailBody({ source, assets }: { source: Asset; assets: AssetStore }) {
  // Always the newest known version, with any in-flight status on top.
  const asset = useAssetView(assets, source);
  const { pending } = useWriteState(assets, asset.id);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const latestRef = useRef(asset);
  latestRef.current = asset;

  async function changeStatus(next: AssetStatus) {
    const base = latestRef.current;
    setError(null);
    setConflict(null);
    const opId = assets.beginWrite([base.id], next);

    try {
      let saved: Asset;
      try {
        saved = await updateAsset(base.id, base.version, { status: next });
      } catch (err) {
        const e = toApiError(err);
        if (e.status !== 409) throw e;

        // 409: the asset changed after we loaded it. Find out what changed.
        const latest = await getAsset(base.id);
        if (latest.status === next) {
          // Already what we asked for: most likely our own write landed, its
          // response was lost, and the automatic retry then saw our change.
          assets.confirm(latest, opId);
          return;
        }
        assets.confirm(latest);
        if (latest.status !== base.status) {
          // Someone else changed the status itself — the same decision this
          // user is making. Neither silently overwrite theirs nor silently
          // drop ours: show both and let the person choose.
          assets.rollback(base.id, opId);
          setConflict({ mine: next, theirs: latest.status });
          return;
        }
        // The concurrent edit touched something else (name, tags). Our change
        // does not overlap it, so apply it on top of the latest version — once.
        saved = await updateAsset(latest.id, latest.version, { status: next });
      }
      assets.confirm(saved, opId);
    } catch (err) {
      assets.rollback(base.id, opId);
      const copy = describeError(toApiError(err));
      setError(`${copy.title}. ${copy.detail}`);
    }
  }

  return (
    <div className="panel__body">
      <Thumbnail asset={asset} className="panel__thumb" />
      <h3 id="detail-name" className="panel__name">
        {asset.name}
      </h3>

      <section>
        <p className="panel__section-label" id="status-label">
          Status{pending ? ' · saving…' : ''}
        </p>
        {/* Left to right, top to bottom: the progression. */}
        <div className="status-picker" role="group" aria-labelledby="status-label">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className="button"
              aria-pressed={status === asset.status}
              disabled={pending || status === asset.status}
              onClick={() => changeStatus(status)}
            >
              <StatusGlyph status={status} colored />
              {statusLabel(status)}
            </button>
          ))}
        </div>
      </section>

      {conflict && (
        <div className="notice-box" role="alert">
          <p>
            While you were looking, someone else moved this asset to{' '}
            <strong>{statusLabel(conflict.theirs)}</strong>. Your change to{' '}
            <strong>{statusLabel(conflict.mine)}</strong> wasn’t saved.
          </p>
          <div className="row">
            <button type="button" className="button button--primary" onClick={() => changeStatus(conflict.mine)}>
              Move to {statusLabel(conflict.mine)} anyway
            </button>
            <button type="button" className="button" onClick={() => setConflict(null)}>
              Keep {statusLabel(conflict.theirs)}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="notice-box" role="alert">
          {error}
        </p>
      )}

      <section>
        <p className="panel__section-label">Details</p>
        <dl className="facts">
          <dt>Id</dt>
          <dd>{asset.id}</dd>
          <dt>Kind</dt>
          <dd>{asset.kind}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(asset.sizeBytes)}</dd>
          {asset.width !== null && asset.height !== null && (
            <>
              <dt>Dimensions</dt>
              <dd>
                {asset.width}×{asset.height}
              </dd>
            </>
          )}
          {asset.durationSec !== null && (
            <>
              <dt>Duration</dt>
              <dd>{formatDuration(asset.durationSec)}</dd>
            </>
          )}
          <dt>Owner</dt>
          <dd>{asset.owner.name}</dd>
          <dt>Updated</dt>
          <dd>{formatDate(asset.updatedAt)}</dd>
          <dt>Version</dt>
          <dd>{asset.version}</dd>
        </dl>
      </section>

      {asset.tags.length > 0 && (
        <section>
          <p className="panel__section-label" id="tags-label">
            Tags
          </p>
          <ul className="tags" aria-labelledby="tags-label">
            {asset.tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
