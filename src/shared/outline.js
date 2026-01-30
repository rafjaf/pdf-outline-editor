import { PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';

const buildOutlineTree = (items, parent = null) => {
  return items.map((item) => ({
    id: item.id ?? crypto.randomUUID(),
    title: item.title,
    pageIndex: item.pageIndex,
    parent,
    children: buildOutlineTree(item.children ?? [], item)
  }));
};

const flattenOutline = (items) => {
  const result = [];
  const walk = (node) => {
    result.push(node);
    node.children.forEach(walk);
  };
  items.forEach(walk);
  return result;
};

const createOutlineEntries = ({ pdfDoc, outlineItems }) => {
  const context = pdfDoc.context;
  const outlineRootRef = context.nextRef();
  const outlineItemsRefs = outlineItems.map(() => context.nextRef());

  const outlineRoot = context.obj({
    Type: PDFName.of('Outlines'),
    First: outlineItemsRefs[0] ?? null,
    Last: outlineItemsRefs[outlineItemsRefs.length - 1] ?? null,
    Count: PDFNumber.of(outlineItems.length)
  });

  const pages = pdfDoc.getPages();

  const entries = outlineItems.map((item, index) => {
    const page = pages[item.pageIndex] ?? pages[0];
    const pageRef = page.ref;
    const destArray = context.obj([pageRef, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(0), null]);

    const entry = context.obj({
      Title: item.title,
      Parent: outlineRootRef,
      Dest: destArray,
      Prev: outlineItemsRefs[index - 1] ?? null,
      Next: outlineItemsRefs[index + 1] ?? null
    });

    return entry;
  });

  return { outlineRootRef, outlineRoot, outlineItemsRefs, entries };
};

export const extractOutline = async (data) => {
  const pdfDoc = await PDFDocument.load(data);
  const outline = pdfDoc.context.lookup(pdfDoc.catalog.get(PDFName.of('Outlines')));

  if (!outline) {
    return [];
  }

  const outlinesDict = outline;
  const firstRef = outlinesDict.get(PDFName.of('First'));
  const outlineItems = [];

  const walk = (ref) => {
    if (!ref) return;
    const item = pdfDoc.context.lookup(ref);
    if (!item) return;

    const title = item.get(PDFName.of('Title'))?.decodeText?.() ?? 'Untitled';
    outlineItems.push({
      id: crypto.randomUUID(),
      title,
      pageIndex: 0,
      children: []
    });

    const nextRef = item.get(PDFName.of('Next'));
    if (nextRef) {
      walk(nextRef);
    }
  };

  if (firstRef) {
    walk(firstRef);
  }

  return outlineItems;
};

export const applyOutlineToPdf = async (data, outlineItems) => {
  const pdfDoc = await PDFDocument.load(data);

  const sanitized = outlineItems.map((item) => ({
    ...item,
    title: item.title ?? 'Untitled',
    pageIndex: Math.max(0, item.pageIndex ?? 0)
  }));

  const flat = flattenOutline(buildOutlineTree(sanitized));

  if (flat.length === 0) {
    return pdfDoc.save();
  }

  const { outlineRootRef, outlineRoot, outlineItemsRefs, entries } = createOutlineEntries({
    pdfDoc,
    outlineItems: flat
  });

  pdfDoc.context.assign(outlineRootRef, outlineRoot);
  entries.forEach((entry, index) => {
    pdfDoc.context.assign(outlineItemsRefs[index], entry);
  });

  pdfDoc.catalog.set(PDFName.of('Outlines'), outlineRootRef);

  return pdfDoc.save();
};
