import { useEffect, useState } from 'react';
import { thumbnailUrl } from '@/api/client';
import { useNetworkState } from '@/api/network';
import type { Asset } from '@/lib/types';

const KIND_LABELS: Record<Asset['kind'], string> = {
  image: 'Image',
  video: 'Video',
  document: 'Document',
};

/**
 * Always occupies the same box, whether it shows an image, is still loading,
 * or has nothing to show, so a thumbnail can never shift the layout. The
 * image is decorative (`alt=""`): the asset's name is right next to it.
 *
 * The server only 404s thumbnails for `hasThumbnail: false`, and those are
 * never requested. Any other load error is the network, so it is not
 * remembered: the image is tried again once the connection is back.
 */
export function Thumbnail({ asset, className }: { asset: Asset; className: string }) {
  const { reachable } = useNetworkState();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (reachable) setFailed(false);
  }, [reachable]);

  if (!asset.hasThumbnail || failed) {
    return (
      <div className={`${className} thumb thumb--missing`} aria-hidden="true">
        <span className="thumb__kind">{KIND_LABELS[asset.kind]}</span>
        <span className="thumb__note">{asset.hasThumbnail ? 'Preview unavailable' : 'No preview'}</span>
      </div>
    );
  }

  return (
    <img
      className={`${className} thumb`}
      src={thumbnailUrl(asset.id)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
