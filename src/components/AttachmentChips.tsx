import type { Attachment } from "../hooks/useAttachments";

interface Props {
  items: readonly Attachment[];
  onRemove: (id: string) => void;
}

/** `.rs`, `.pdf` — what a file without a picture shows instead of one. */
function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "file";
  return name.slice(dot + 1).toLowerCase().slice(0, 5);
}

/**
 * What is going with the next prompt, above the composer.
 *
 * A thumbnail where there is a picture and the extension where there is not, so
 * a row of attachments is scannable without reading a single filename — which
 * is the point of showing them at all rather than pasting paths into the text.
 *
 * The remove button sits over the corner rather than beside the name: the chip
 * is mostly picture, and a control that moves with the length of a filename is
 * a control you have to look for.
 */
export function AttachmentChips({ items, onRemove }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="attachment-chips" aria-label="Attachments">
      {items.map((item) => (
        <div
          key={item.id}
          className={
            item.preview ? "attachment-chip has-preview" : "attachment-chip"
          }
          // The full path: the chip shows a basename, and two files with the
          // same name from different folders are the normal case, not the odd one.
          title={item.path}
        >
          {item.preview ? (
            <img className="attachment-chip-image" src={item.preview} alt="" />
          ) : (
            <span className="attachment-chip-ext" aria-hidden>
              {extensionLabel(item.name)}
            </span>
          )}
          <span className="attachment-chip-name">{item.name}</span>
          <button
            type="button"
            className="attachment-chip-remove"
            aria-label={`Remove ${item.name}`}
            title="Remove"
            onClick={() => onRemove(item.id)}
          >
            <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden focusable="false">
              <path
                d="M3 3l6 6M9 3l-6 6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
