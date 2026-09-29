/**
 * Choosing a picture, and getting it to the exact shape the app wants.
 *
 * THE CROP HAPPENS HERE, IN THE BROWSER, and that is the whole design. The
 * studio server has no image library - resvg draws SVGs and nothing in the
 * dependency list can resize a photograph - so the alternatives were a native
 * dependency on every machine that runs this, or refusing every file that is
 * not already 1024x1024. A canvas does it in six lines and the server receives
 * something already correct.
 *
 * WHICH MEANS THE SERVER'S CHECK IS NOT REDUNDANT. It is the check for the
 * other door: a file dropped into art/ by hand, or a request that did not come
 * from this page. Two checks because there are two ways in, not because one is
 * a belt for the other's braces.
 *
 * CENTRE-CROP, AND IT IS SAID OUT LOUD. Anything cleverer needs a dragging
 * cropper, which is a real feature rather than a detail of this one; what
 * matters is that somebody is told their edges will be trimmed BEFORE they
 * wonder where the edges went.
 */
import { useEffect, useRef, useState } from 'react';
import { type ArtState } from '../api';
import { Info } from './Info';

/**
 * Redraw a chosen file at exactly the size wanted, keeping the middle.
 *
 * PNG OUT, WHATEVER WENT IN. A canvas has already thrown away the original
 * encoding by the time this runs, so re-encoding as JPEG would be a second
 * generation of loss to save bytes on a file that is uploaded once.
 */
const cropTo = (file: File, width: number, height: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('this browser will not draw to a canvas'));

      // Cover, not contain: fill the frame and lose the overflow, rather than
      // fit inside it and leave bars the app would treat as part of the art.
      const scale = Math.max(width / img.width, height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;

      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('the image could not be re-encoded'))),
        'image/png'
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('that file is not an image this browser can open'));
    };

    img.src = url;
  });

export const ImagePicker = ({
  title,
  note,
  state,
  src,
  onUpload,
  onRemove,
  disabled,
}: {
  title: string;
  note: string;
  state: ArtState | null;
  /** Where to fetch the current picture. Null while there is not one yet. */
  src: string | null;
  onUpload: (image: Blob) => Promise<void>;
  onRemove: () => Promise<void>;
  disabled?: boolean;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A NEW FILE AT THE SAME URL. The browser caches an <img> by its src, and
  // every upload here writes to the same address, so without something that
  // changes the preview keeps showing the picture that was just replaced.
  const [version, setVersion] = useState(0);
  useEffect(() => setVersion((v) => v + 1), [state?.supplied]);

  const choose = async (file: File | undefined) => {
    if (!file || !state) return;
    setError(null);
    setBusy(true);
    try {
      await onUpload(await cropTo(file, state.width, state.height));
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      // Cleared so choosing the SAME file again still fires a change event,
      // which is what somebody does after a failure they have just fixed.
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await onRemove();
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shape = state ? `${state.width}x${state.height}` : '';

  return (
    <div className="art-picker">
      <div className={`art-thumb${state?.supplied ? ' chosen' : ''}`}>
        {src ? (
          <img src={`${src}${src.includes('?') ? '&' : '?'}v=${version}`} alt="" />
        ) : (
          <span className="faint tiny">none yet</span>
        )}
      </div>

      <div className="art-detail">
        <div className="row" style={{ gap: '0.4rem', alignItems: 'baseline' }}>
          <strong>{title}</strong>
          {state?.supplied ? (
            <span className="pill pass">yours</span>
          ) : (
            <span className="pill">drawn</span>
          )}
          <span className="right-edge">
            <Info label={`About the ${title.toLowerCase()}`}>
              {note} Anything you choose is cropped to {shape} from the middle, so keep the part
              that matters away from the edges. The studio only draws one when you have not
              supplied one, and a redraw never replaces yours - remove it first if you want the
              drawn version back.
            </Info>
          </span>
        </div>

        <span className="faint tiny">{shape}, PNG, JPEG or WebP</span>

        {error && <span className="tiny bad">{error}</span>}

        <div className="row" style={{ gap: '0.4rem' }}>
          <button
            className="btn small"
            disabled={busy || disabled || !state}
            onClick={() => input.current?.click()}
          >
            {busy ? 'Working...' : state?.supplied ? 'Replace' : 'Choose a file'}
          </button>

          {state?.supplied && (
            <button className="btn small ghost" disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          )}
        </div>

        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </div>
    </div>
  );
};
