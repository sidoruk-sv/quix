import {omit} from 'lodash';
import {IItemDef, IPathItemDef} from './';
import {Item, Folder, File} from './file-explorer-models';

function getId(parent) {
  return typeof parent === 'object' ? parent.id : parent;
}

/**
 * Opens all folders on the path to file
 */
export function goToFile(fileDef: IItemDef, folder: Folder): File {
  fileDef.path.forEach(parent => {
    folder = folder.getFolderById(getId(parent)).toggleOpen(true);
  });

  return folder.getFileById(fileDef.id) || folder.getFolderById(fileDef.id);
}

/**
 * Creates a tree structure from a file definition array.
 */
export function defToTree(items: IItemDef[]): Folder {
  const root = new Folder(null, null);
  const itemsMap = items.reduce((res, item: IItemDef) => {
    res[item.id] = item;
    return res;
  }, {});

  items.forEach(item => {
    let folder = root;

    (item.path || []).forEach((parent) => {
      const id = getId(parent);

      folder = folder.getFolderById(id) || folder.addFolder(id, itemsMap[id].name, omit(itemsMap[id], 'id', 'name', 'type', 'path'));

      if (item.type !== 'folder') {
        folder.toggleHasFileLeaf(true);
      }
    });

    if (item.type === 'folder') {
      if (!folder.getFolderById(item.id)) {
        folder.addFolder(item.id, itemsMap[item.id].name, omit(itemsMap[item.id], 'id', 'name', 'type', 'path')).setLazy(item.lazy);
      }
    } else {
      folder.addFile(item.id, item.name, item.type, omit(itemsMap[item.id], 'id', 'name', 'type', 'path'));
    }
  });

  return root;
}

/**
 * Creates a file definition array from a tree.
 */
export function treeToDef(item: Item, path = [], res: IItemDef[] = []): IItemDef[] {
  if (item instanceof File || (item as Folder).isEmpty()) {
    res.push({
      id: item.getId(),
      name: item.getName(),
      type: item.getType(),
      path,
      ...item.getData()
    });
  } else {
    (item as Folder).getFolders().forEach(folder => {
      treeToDef(folder, path.concat([{
        id: folder.getId(),
        name: folder.getName()
      }]), res);
    });

    (item as Folder).getFiles().forEach(file => treeToDef(file, path, res));
  }

  return res;
}

/**
 * Creates a file definition object from file
 */
export function itemToDef(item: Item): IItemDef {
  const path: IPathItemDef[] = [];
  let folder: Folder = item.getParent();

  while (folder && folder.getParent()) {
    path.unshift({
      id: folder.getId(),
      name: folder.getName()
    });

    folder = folder.getParent();
  }

  return {
    id: item.getId(),
    name: item.getName(),
    type: item.getType(),
    path,
    ...item.getData()
  };
}