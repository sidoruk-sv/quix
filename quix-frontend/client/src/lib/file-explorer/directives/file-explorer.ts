import {assign, isArray} from 'lodash';
import {createNgModel, initNgScope, inject} from '../../core';
import {IItemDef} from '../services';
import {File, Folder} from '../services/file-explorer-models';
import {treeToDef, defToTree} from '../services/file-explorer-tools';
import Controller from '../services/file-explorer-controller';
import VM from './file-explorer-vm';

import template from './file-explorer.html';
import './file-explorer.scss';

function directive(params) {
  return assign({
    template,
    restrict: 'E'
  }, params);
}

function initScope(scope, controller: Controller, depth: number) {
  scope.depth = depth;
  scope.renderFolderIcon = (folder) => controller.renderFolderIcon(scope, folder);
  scope.renderFileIcon = (file) => controller.renderFileIcon(scope, file);
  scope.renderMenu = (folder) => controller.renderMenu(scope, folder);

  const helper = initNgScope(scope)
    .readonly(scope.readonly)
    .withOptions('feOptions', {
      fileAlias: 'file',
      orderBy: 'name', // name|dateCreated|dateUpdated
      orderReversed: false,
      expandAllFolders: false,
      hideEmptyFolders: false,
      folderMode: 'expand', // expand|select 
      settings: false
    }, ({orderBy, orderReversed, fileAlias}) => {
      scope.options.fileAlias = isArray(fileAlias) ? fileAlias : [fileAlias];
      scope.vm.order.setField(orderBy, orderReversed);
    })
    .withVM(VM)
    .withEditableEvents({
      onFileCreate(type = scope.options.fileAlias[0], folder?: Folder) {
        const file = (folder || scope.model).toggleOpen(true).createFile(`New ${type}`, type);
        controller.syncItem(file, 'fileCreated', type);
      },
      onFolderDelete(folder: Folder) {
        folder.destroy();

        if (folder.getParent().isEmpty()) {
          folder.getParent().toggleOpen(false);
        }

        controller.syncItem(folder, 'folderDeleted');
      },
      onFolderRename(folder: Folder) {
        scope.vm.folder.toggleEdit(folder, true);
      },
      onFolderRenamed(folder: Folder) {
        controller.syncItem(folder, 'folderRenamed');
      }
    })
    .withEvents({
      onItemDrop(_, __, folder: Folder) {
        scope.vm.dropped.item.moveTo(folder);

        if (scope.vm.dropped.item instanceof File) {
          controller.syncItem(scope.vm.dropped.item, 'fileMoved');
        } else {
          controller.syncItem(scope.vm.dropped.item, 'folderMoved');
        }
      },
      onFolderDragStart(_, __, folder: Folder) {
        // scope.vm.folder.toggleOpen(folder, false);
      },
      onFolderBlur(folder: Folder) {
        scope.vm.folder.toggleEdit(folder, false);
      },
      onFolderToggle(folder: Folder) {
        if (!scope.vm.folders.get(folder).edit.enabled) {
          scope.vm.folder.toggleOpen(folder);

          if (folder.isLazy() && scope.vm.folder.isOpen(folder)) {
            const promise = controller.fetchLazyFolder(folder);

            if (promise && promise.then) {
              promise.then(() => folder.setLazy(false));
            }
          }
        }
      },
      onFolderClick(folder: Folder) {
        if (scope.options.folderMode === 'select') {
          scope.vm.folder.setCurrent(folder);
          scope.vm.file.setCurrent(null);
          controller.clickFolder(folder);
        } else {
          scope.events.onFolderToggle(folder);
        }
      },
      onFileClick(file: File) {
        if (scope.options.folderMode === 'select') {
          scope.vm.file.setCurrent(file);
          scope.vm.folder.setCurrent(null);
          controller.clickFile(file);
        }
      },
      onSettingsClick(folder: Folder) {
        controller.fireEvent(folder, 'settingsClicked');
      }
    });

    if (depth < 2) {
      helper.withEditableEvents({
        onFolderCreate(folder?: Folder) {
          folder = (folder || scope.model).toggleOpen(true);

          inject('$timeout')(() => {
            folder = folder
              .createFolder('New folder')
              .toggleEdit(true);

            controller.syncItem(folder, 'folderCreated');
          });
        }
      });
    }
}

export function fileExplorerInner() {
  return directive({
    require: '^biFileExplorer',
    scope: {
      model: '=',
      feOptions: '<',
      readonly: '='
    },

    link: {
      pre: (scope, element, attrs, controller) => {
        scope.$watch('model', model => scope.vm.init({controller, item: scope.model, options: scope.options}));

        initScope(scope, controller, element.parents('bi-file-explorer-inner').length as number + 1);
      }
    }
  });
}

export function fileExplorer() {
  return directive({
    require: ['ngModel', 'biFileExplorer'],
    transclude: {
      folderIcon: '?folderIcon',
      fileIcon: '?fileIcon',
      menu: '?menu'
    },
    controller: ['$scope', '$element', '$transclude', Controller],
    scope: {
      feOptions: '<',
      onLazyFolderFetch: '&',
      onFileClick: '&',
      onFolderClick: '&',
      onLoad: '&',
      permissions: '&',
      emptyText: '@',
      readonly: '='
    },
    link: {
      pre: (scope, element, attrs, [ngModel, controller]: [ng.INgModelController, Controller]) => {
        createNgModel(scope, ngModel)
          .formatWith((model: IItemDef[]) => defToTree(model))
          .parseWith((model: Folder) => treeToDef(model))
          .renderWith((model: Folder) => {
            scope.vm.init({controller, item: model, options: scope.options});
          })
          .then(() => {
            scope.onLoad({fileExplorer: controller.getInstance()});
          })
          .feedBack(false);

        initScope(scope, controller, 0);

        scope.container = element.addClass(`fe-folder-mode-${scope.options.folderMode}`);
      }
    }
  });
}

