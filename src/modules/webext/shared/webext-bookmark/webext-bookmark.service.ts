import angular from 'angular';
import autobind from 'autobind-decorator';
import { Bookmarks as NativeBookmarks } from 'webextension-polyfill-ts';
import { BookmarkChangeType, BookmarkContainer, BookmarkType } from '../../../shared/bookmark/bookmark.enum';
import {
  AddNativeBookmarkChangeData,
  Bookmark,
  BookmarkChange,
  BookmarkMetadata,
  BookmarkService,
  ModifyNativeBookmarkChangeData,
  MoveNativeBookmarkChangeData,
  OnChildrenReorderedReorderInfoType,
  RemoveNativeBookmarkChangeData,
  ReorderNativeBookmarkChangeData,
  UpdateBookmarksResult
} from '../../../shared/bookmark/bookmark.interface';
import { BookmarkHelperService } from '../../../shared/bookmark/bookmark-helper/bookmark-helper.service';
import * as Exceptions from '../../../shared/exception/exception';
import { MessageCommand } from '../../../shared/global-shared.enum';
import { PlatformService, WebpageMetadata } from '../../../shared/global-shared.interface';
import { LogService } from '../../../shared/log/log.service';
import { SettingsService } from '../../../shared/settings/settings.service';
import { StoreService } from '../../../shared/store/store.service';
import { SyncType } from '../../../shared/sync/sync.enum';
import { Sync } from '../../../shared/sync/sync.interface';
import { SyncService } from '../../../shared/sync/sync.service';
import { UtilityService } from '../../../shared/utility/utility.service';
import { BookmarkIdMapperService } from '../bookmark-id-mapper/bookmark-id-mapper.service';

@autobind
export abstract class WebExtBookmarkService implements BookmarkService {
  $injector: ng.auto.IInjectorService;
  $q: ng.IQService;
  $timeout: ng.ITimeoutService;
  bookmarkIdMapperSvc: BookmarkIdMapperService;
  bookmarkHelperSvc: BookmarkHelperService;
  logSvc: LogService;
  platformSvc: PlatformService;
  settingsSvc: SettingsService;
  storeSvc: StoreService;
  _syncSvc: SyncService;
  utilitySvc: UtilityService;

  nativeBookmarkEventsQueue: any[] = [];
  processNativeBookmarkEventsTimeout: ng.IPromise<void>;
  unsupportedContainers = [];

  static $inject = [
    '$injector',
    '$q',
    '$timeout',
    'BookmarkHelperService',
    'BookmarkIdMapperService',
    'LogService',
    'PlatformService',
    'SettingsService',
    'StoreService',
    'UtilityService'
  ];
  constructor(
    $injector: ng.auto.IInjectorService,
    $q: ng.IQService,
    $timeout: ng.ITimeoutService,
    BookmarkHelperSvc: BookmarkHelperService,
    BookmarkIdMapperSvc: BookmarkIdMapperService,
    LogSvc: LogService,
    PlatformSvc: PlatformService,
    SettingsSvc: SettingsService,
    StoreSvc: StoreService,
    UtilitySvc: UtilityService
  ) {
    this.$injector = $injector;
    this.$q = $q;
    this.$timeout = $timeout;
    this.bookmarkIdMapperSvc = BookmarkIdMapperSvc;
    this.bookmarkHelperSvc = BookmarkHelperSvc;
    this.logSvc = LogSvc;
    this.platformSvc = PlatformSvc;
    this.settingsSvc = SettingsSvc;
    this.storeSvc = StoreSvc;
    this.utilitySvc = UtilitySvc;
  }

  get syncSvc(): SyncService {
    if (angular.isUndefined(this._syncSvc)) {
      this._syncSvc = this.$injector.get('SyncService');
    }
    return this._syncSvc;
  }

  addBookmark(bookmark: Bookmark, parentId: number, index: number, bookmarks: Bookmark[]): UpdateBookmarksResult {
    // Add bookmark as child at index param
    const updatedBookmarks = angular.copy(bookmarks);
    const parent = this.bookmarkHelperSvc.findBookmarkById(parentId, updatedBookmarks);
    if (!parent) {
      throw new Exceptions.BookmarkNotFoundException();
    }
    parent.children.splice(index, 0, bookmark);

    return {
      bookmark,
      bookmarks: updatedBookmarks
    } as UpdateBookmarksResult;
  }

  buildIdMappings(): ng.IPromise<void> {
    return this.methodNotApplicable();
  }

  checkIfBookmarkChangeShouldBeSynced(changedBookmark: Bookmark, bookmarks: Bookmark[]): ng.IPromise<boolean> {
    return this.settingsSvc.syncBookmarksToolbar().then((syncBookmarksToolbar) => {
      // If container is Toolbar, check if Toolbar sync is disabled
      const container = this.bookmarkHelperSvc.getContainerByBookmarkId(changedBookmark.id, bookmarks);
      if (!container) {
        throw new Exceptions.ContainerNotFoundException();
      }
      if (container.title === BookmarkContainer.Toolbar && !syncBookmarksToolbar) {
        this.logSvc.logInfo('Not syncing toolbar');
        return false;
      }
      return true;
    });
  }

  checkPermsAndGetPageMetadata(): ng.IPromise<WebpageMetadata> {
    return this.platformSvc.checkOptionalNativePermissions().then((hasPermissions) => {
      if (!hasPermissions) {
        this.logSvc.logInfo('Do not have permission to read active tab content');
      }

      // Depending on current perms, get full or partial page metadata
      return hasPermissions ? this.platformSvc.getPageMetadata(true) : this.platformSvc.getPageMetadata(false);
    });
  }

  abstract clearNativeBookmarks(): ng.IPromise<void>;

  convertNativeBookmarkToBookmark(
    nativeBookmark: NativeBookmarks.BookmarkTreeNode,
    bookmarks: Bookmark[],
    takenIds?: number[]
  ): Bookmark {
    if (!nativeBookmark) {
      return;
    }

    // Get a new bookmark id and add to taken ids array so that ids are not duplicated before bookmarks are updated
    const id = this.bookmarkHelperSvc.getNewBookmarkId(bookmarks, takenIds);
    if (angular.isUndefined(takenIds)) {
      takenIds = [];
    }
    takenIds.push(id);

    // Create the new bookmark
    const bookmark = this.bookmarkHelperSvc.newBookmark(nativeBookmark.title, nativeBookmark.url);
    bookmark.id = id;

    // Process children if any
    if (nativeBookmark.children?.length) {
      bookmark.children = nativeBookmark.children.map((childBookmark) => {
        return this.convertNativeBookmarkToBookmark(childBookmark, bookmarks, takenIds);
      });
    }

    return bookmark;
  }

  createNativeBookmark(
    parentId: string,
    title: string,
    url: string,
    index?: number
  ): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    return this.methodNotApplicable();
  }

  abstract createNativeBookmarksFromBookmarks(bookmarks: Bookmark[]): ng.IPromise<number>;

  createNativeBookmarkTree(
    parentId: string,
    bookmarks: Bookmark[],
    nativeToolbarContainerId?: string
  ): ng.IPromise<number> {
    let processError: Error;
    let total = 0;
    const createRecursive = (id: string, bookmarksToCreate: Bookmark[] = [], toolbarId: string) => {
      const createChildBookmarksPromises = [];

      // Create bookmarks at the top level of the supplied array
      return bookmarksToCreate
        .reduce((p, bookmark) => {
          return p.then(() => {
            // If an error occurred during the recursive process, prevent any more bookmarks being created
            if (processError) {
              return this.$q.resolve();
            }

            return this.bookmarkHelperSvc.getBookmarkType(bookmark) === BookmarkType.Separator
              ? this.createNativeSeparator(id, toolbarId).then(() => {})
              : this.createNativeBookmark(id, bookmark.title, bookmark.url).then((newNativeBookmark) => {
                  // If the bookmark has children, recurse
                  if (bookmark.children?.length) {
                    createChildBookmarksPromises.push(
                      createRecursive(newNativeBookmark.id, bookmark.children, toolbarId)
                    );
                  }
                });
          });
        }, this.$q.resolve())
        .then(() => this.$q.all(createChildBookmarksPromises))
        .then(() => {
          total += bookmarksToCreate.length;
        })
        .catch((err) => {
          processError = err;
          throw err;
        });
    };
    return createRecursive(parentId, bookmarks, nativeToolbarContainerId).then(() => total);
  }

  abstract createNativeSeparator(
    parentId: string,
    nativeToolbarContainerId: string
  ): ng.IPromise<NativeBookmarks.BookmarkTreeNode>;

  abstract disableEventListeners(): ng.IPromise<void>;

  abstract enableEventListeners(): ng.IPromise<void>;

  abstract ensureContainersExist(bookmarks: Bookmark[]): Bookmark[];

  getBookmarksForExport(): ng.IPromise<Bookmark[]> {
    return this.utilitySvc
      .isSyncEnabled()
      .then((syncEnabled) => {
        // If sync is not enabled, export native bookmarks
        return syncEnabled ? this.bookmarkHelperSvc.getCachedBookmarks() : this.getNativeBookmarksAsBookmarks();
      })
      .then((bookmarks) => {
        // Clean bookmarks for export
        return this.bookmarkHelperSvc.cleanAllBookmarks(this.bookmarkHelperSvc.removeEmptyContainers(bookmarks));
      });
  }

  getContainerNameFromNativeId(nativeBookmarkId: string): ng.IPromise<string> {
    return this.getNativeContainerIds().then((nativeContainerIds) => {
      const menuBookmarksId = nativeContainerIds.get(BookmarkContainer.Menu);
      const mobileBookmarksId = nativeContainerIds.get(BookmarkContainer.Mobile);
      const otherBookmarksId = nativeContainerIds.get(BookmarkContainer.Other);
      const toolbarBookmarksId = nativeContainerIds.get(BookmarkContainer.Toolbar);

      const nativeContainers = [
        { nativeId: otherBookmarksId, containerName: BookmarkContainer.Other },
        { nativeId: toolbarBookmarksId, containerName: BookmarkContainer.Toolbar }
      ];

      if (menuBookmarksId) {
        nativeContainers.push({ nativeId: menuBookmarksId, containerName: BookmarkContainer.Menu });
      }

      if (mobileBookmarksId) {
        nativeContainers.push({ nativeId: mobileBookmarksId, containerName: BookmarkContainer.Mobile });
      }

      // Check if the native bookmark id resolves to a container
      const result = nativeContainers.find((x) => x.nativeId === nativeBookmarkId);
      return result ? result.containerName : '';
    });
  }

  getIdsFromDescendants(bookmark: Bookmark): number[] {
    const ids = [];
    if (angular.isUndefined(bookmark.children ?? undefined) || bookmark.children.length === 0) {
      return ids;
    }

    this.bookmarkHelperSvc.eachBookmark(bookmark.children, (child) => {
      ids.push(child.id);
    });
    return ids;
  }

  getNativeBookmarkByTitle(title: string): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    return this.$q.resolve(null);
  }

  abstract getNativeBookmarksAsBookmarks(): ng.IPromise<Bookmark[]>;

  abstract getNativeContainerIds(): ng.IPromise<Map<BookmarkContainer, string>>;

  getSupportedUrl(url: string): string {
    if (angular.isUndefined(url ?? undefined)) {
      return '';
    }

    // If url is not supported, use new tab url instead
    let returnUrl = url;
    if (!this.platformSvc.urlIsSupported(url)) {
      this.logSvc.logInfo(`Bookmark url unsupported: ${url}`);
      returnUrl = this.platformSvc.getNewTabUrl();
    }

    return returnUrl;
  }

  isNativeBookmarkInToolbarContainer(nativeBookmark: NativeBookmarks.BookmarkTreeNode): ng.IPromise<boolean> {
    return this.getNativeContainerIds().then((nativeContainerIds) => {
      return nativeBookmark.parentId === nativeContainerIds.get(BookmarkContainer.Toolbar);
    });
  }

  onNativeBookmarkChanged(...args: any[]): void {
    this.logSvc.logInfo('onChanged event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Modify, ...args);
  }

  onNativeBookmarkCreated(...args: any[]): void {
    this.logSvc.logInfo('onCreated event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Add, ...args);
  }

  onNativeBookmarkMoved(...args: any[]): void {
    this.logSvc.logInfo('onMoved event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Move, ...args);
  }

  onNativeBookmarkRemoved(...args: any[]): void {
    this.logSvc.logInfo('onRemoved event detected');
    this.queueNativeBookmarkEvent(BookmarkChangeType.Remove, ...args);
  }

  processChangeOnNativeBookmarks(
    id: number,
    changeType: BookmarkChangeType,
    changeInfo: BookmarkMetadata
  ): ng.IPromise<void> {
    return this.methodNotApplicable();
  }

  processChangeTypeAddOnBookmarks(
    bookmarks: Bookmark[],
    changeData: AddNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    // Check if container was changed
    return this.wasContainerChanged(changeData.nativeBookmark).then((changedBookmarkIsContainer) => {
      if (changedBookmarkIsContainer) {
        throw new Exceptions.ContainerChangedException();
      }

      return this.getContainerNameFromNativeId(changeData.nativeBookmark.parentId)
        .then((containerName) => {
          if (containerName) {
            // If parent is a container use it's id
            const container = this.bookmarkHelperSvc.getContainer(containerName, bookmarks, true);
            return container.id as number;
          }

          // Get the synced parent id from id mappings and retrieve the synced parent bookmark
          return this.bookmarkIdMapperSvc.get(changeData.nativeBookmark.parentId).then((idMapping) => {
            if (!idMapping) {
              // No mappings found, skip sync
              this.logSvc.logInfo('No id mapping found, skipping sync');
              return;
            }

            return idMapping.syncedId;
          });
        })
        .then((parentId) => {
          if (!parentId) {
            // Don't sync this change
            return bookmarks;
          }

          // Add new bookmark then check if the change should be synced
          const newBookmarkMetadata = this.bookmarkHelperSvc.extractBookmarkMetadata(changeData.nativeBookmark);
          const newBookmark = this.bookmarkHelperSvc.newBookmark(
            newBookmarkMetadata.title,
            newBookmarkMetadata.url,
            newBookmarkMetadata.description,
            newBookmarkMetadata.tags,
            bookmarks
          );
          const addBookmarkResult = this.addBookmark(newBookmark, parentId, changeData.nativeBookmark.index, bookmarks);

          return this.checkIfBookmarkChangeShouldBeSynced(addBookmarkResult.bookmark, addBookmarkResult.bookmarks).then(
            (syncThisChange) => {
              if (!syncThisChange) {
                // Don't sync this change
                return bookmarks;
              }
              // Add new id mapping
              const idMapping = this.bookmarkIdMapperSvc.createMapping(
                addBookmarkResult.bookmark.id,
                changeData.nativeBookmark.id
              );
              return this.bookmarkIdMapperSvc.add(idMapping).then(() => {
                return addBookmarkResult.bookmarks;
              });
            }
          );
        });
    });
  }

  processChangeTypeChildrenReorderedOnBookmarks(
    bookmarks: Bookmark[],
    changeData: ReorderNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    // Check if parent bookmark is a container
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        // If parent is not a container, find bookmark using mapped id
        const containerName = [...nativeContainerIds].find(({ 1: x }) => x === changeData.parentId)?.[0];
        if (angular.isUndefined(containerName)) {
          return this.bookmarkIdMapperSvc
            .get(changeData.parentId)
            .then((idMapping) => this.bookmarkHelperSvc.findBookmarkById(idMapping.syncedId, bookmarks));
        }

        // Otherwise get the relavant container
        return this.$q.resolve().then(() => this.bookmarkHelperSvc.getContainer(containerName, bookmarks));
      })
      .then((parentBookmark) => {
        // Retrieve child id mappings using change data
        return this.$q
          .all(changeData.childIds.map((childId) => this.bookmarkIdMapperSvc.get(childId)))
          .then((idMappings) => {
            // Reorder children as per change data
            const childIds = idMappings.filter(Boolean).map((idMapping) => idMapping.syncedId);
            parentBookmark.children = childIds.map<Bookmark>((childId) => {
              return (parentBookmark.children as Bookmark[]).find((x) => x.id === childId);
            });

            return bookmarks;
          });
      });
  }

  processChangeTypeAddOnNativeBookmarks(id: number, createInfo: BookmarkMetadata): ng.IPromise<void> {
    // Create native bookmark in other bookmarks container
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        const otherBookmarksId = nativeContainerIds.get(BookmarkContainer.Other);
        return this.createNativeBookmark(otherBookmarksId, createInfo.title, createInfo.url);
      })
      .then((newNativeBookmark) => {
        // Add id mapping for new bookmark
        const idMapping = this.bookmarkIdMapperSvc.createMapping(id, newNativeBookmark.id);
        return this.bookmarkIdMapperSvc.add(idMapping);
      });
  }

  processChangeTypeModifyOnBookmarks(
    bookmarks: Bookmark[],
    changeData: ModifyNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    // Check if container was changed
    return this.wasContainerChanged(changeData.nativeBookmark).then((changedBookmarkIsContainer) => {
      if (changedBookmarkIsContainer) {
        throw new Exceptions.ContainerChangedException();
      }

      // Retrieve id mapping using change data
      return this.bookmarkIdMapperSvc.get(changeData.nativeBookmark.id).then((idMapping) => {
        if (!idMapping) {
          // No mappings found, skip sync
          this.logSvc.logInfo('No id mapping found, skipping sync');
          return bookmarks;
        }

        // Check if the change should be synced
        const bookmarkToUpdate = this.bookmarkHelperSvc.findBookmarkById(idMapping.syncedId, bookmarks) as Bookmark;
        return this.checkIfBookmarkChangeShouldBeSynced(bookmarkToUpdate, bookmarks).then((syncThisChange) => {
          if (!syncThisChange) {
            // Don't sync this change
            return bookmarks;
          }

          // Modify the bookmark with the update info
          const updateInfo = this.bookmarkHelperSvc.extractBookmarkMetadata(changeData.nativeBookmark);
          return this.bookmarkHelperSvc.modifyBookmarkById(idMapping.syncedId, updateInfo, bookmarks);
        });
      });
    });
  }

  processChangeTypeMoveOnBookmarks(
    bookmarks: Bookmark[],
    changeData: MoveNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    return this.methodNotApplicable();
  }

  processChangeTypeRemoveOnBookmarks(
    bookmarks: Bookmark[],
    changeData: RemoveNativeBookmarkChangeData
  ): ng.IPromise<Bookmark[]> {
    // Check if container was changed
    return this.wasContainerChanged(changeData.nativeBookmark).then((changedBookmarkIsContainer) => {
      if (changedBookmarkIsContainer) {
        throw new Exceptions.ContainerChangedException();
      }

      // Retrieve the id mapping using change data
      return this.bookmarkIdMapperSvc.get(changeData.nativeBookmark.id).then((idMapping) => {
        if (!idMapping) {
          // No mappings found, skip sync
          this.logSvc.logInfo('No id mapping found, skipping sync');
          return bookmarks;
        }

        // Check if the change should be synced
        const bookmarkToRemove = this.bookmarkHelperSvc.findBookmarkById(idMapping.syncedId, bookmarks) as Bookmark;
        return this.checkIfBookmarkChangeShouldBeSynced(bookmarkToRemove, bookmarks).then((syncThisChange) => {
          if (!syncThisChange) {
            // Don't sync this change
            return bookmarks;
          }

          // Get all child bookmark mappings
          const descendantsIds = this.getIdsFromDescendants(bookmarkToRemove);

          // Remove bookmark
          return this.bookmarkHelperSvc.removeBookmarkById(idMapping.syncedId, bookmarks).then((updatedBookmarks) => {
            // Remove all retrieved ids from mappings
            const syncedIds = descendantsIds.concat([idMapping.syncedId]);
            return this.bookmarkIdMapperSvc.remove(syncedIds).then(() => {
              return updatedBookmarks;
            });
          });
        });
      });
    });
  }

  processChangeTypeRemoveOnNativeBookmarks(id: number): ng.IPromise<void> {
    return this.methodNotApplicable();
  }

  processNativeBookmarkEventsQueue(): void {
    const condition = (): ng.IPromise<boolean> => {
      return this.$q.resolve(this.nativeBookmarkEventsQueue.length > 0);
    };

    const action = (): ng.IPromise<void> => {
      // Get first event in the queue and process change
      const currentEvent = this.nativeBookmarkEventsQueue.shift();
      switch (currentEvent.changeType) {
        case BookmarkChangeType.Add:
          return this.syncNativeBookmarkCreated(...currentEvent.eventArgs);
        case BookmarkChangeType.ChildrenReordered:
          return this.syncNativeBookmarkChildrenReordered(...currentEvent.eventArgs);
        case BookmarkChangeType.Remove:
          return this.syncNativeBookmarkRemoved(...currentEvent.eventArgs);
        case BookmarkChangeType.Move:
          return this.syncNativeBookmarkMoved(...currentEvent.eventArgs);
        case BookmarkChangeType.Modify:
          return this.syncNativeBookmarkChanged(...currentEvent.eventArgs);
        default:
          throw new Exceptions.AmbiguousSyncRequestException();
      }
    };

    // Iterate through the queue and process the events
    this.utilitySvc.asyncWhile<any>(this.nativeBookmarkEventsQueue, condition, action).then(() => {
      this.$timeout(() => {
        this.syncSvc.executeSync().then(() => {
          // Move native unsupported containers into the correct order
          return this.disableEventListeners().then(this.reorderUnsupportedContainers).then(this.enableEventListeners);
        });
      }, 100);
    });
  }

  processNativeChangeOnBookmarks(changeInfo: BookmarkChange, bookmarks: Bookmark[]): ng.IPromise<Bookmark[]> {
    return this.methodNotApplicable();
  }

  queueNativeBookmarkEvent(changeType: BookmarkChangeType, ...eventArgs: any[]): void {
    // Clear timeout
    if (this.processNativeBookmarkEventsTimeout) {
      this.$timeout.cancel(this.processNativeBookmarkEventsTimeout);
    }

    // Add event to the queue and trigger processing after a delay
    this.nativeBookmarkEventsQueue.push({
      changeType,
      eventArgs
    });
    this.processNativeBookmarkEventsTimeout = this.$timeout(this.processNativeBookmarkEventsQueue, 200);
  }

  reorderUnsupportedContainers(): ng.IPromise<void> {
    // Get unsupported containers
    return this.methodNotApplicable();
  }

  syncChange(changeInfo: BookmarkChange): ng.IPromise<any> {
    const sync: Sync = {
      changeInfo,
      type: SyncType.Remote
    };

    // Queue sync but dont execute sync to allow for batch processing multiple changes
    return this.platformSvc.queueSync(sync, MessageCommand.SyncBookmarks, false).catch(() => {
      // Swallow error, sync errors thrown separately by processBookmarkEventsQueue
    });
  }

  abstract syncNativeBookmarkChanged(id?: string): ng.IPromise<void>;

  syncNativeBookmarkChildrenReordered(
    id?: string,
    reorderInfo?: OnChildrenReorderedReorderInfoType
  ): ng.IPromise<void> {
    // Create change info
    const data: ReorderNativeBookmarkChangeData = {
      childIds: reorderInfo.childIds,
      parentId: id
    };
    const changeInfo: BookmarkChange = {
      changeData: data,
      type: BookmarkChangeType.ChildrenReordered
    };

    // Queue sync
    this.syncChange(changeInfo);
    return this.$q.resolve();
  }

  abstract syncNativeBookmarkCreated(id?: string, nativeBookmark?: NativeBookmarks.BookmarkTreeNode): ng.IPromise<void>;

  abstract syncNativeBookmarkMoved(id?: string, moveInfo?: NativeBookmarks.OnMovedMoveInfoType): ng.IPromise<void>;

  syncNativeBookmarkRemoved(id?: string, removeInfo?: NativeBookmarks.OnRemovedRemoveInfoType): ng.IPromise<void> {
    // Create change info
    const data: RemoveNativeBookmarkChangeData = {
      nativeBookmark: {
        ...removeInfo.node,
        parentId: removeInfo.parentId
      }
    };
    const changeInfo: BookmarkChange = {
      changeData: data,
      type: BookmarkChangeType.Remove
    };

    // Queue sync
    this.syncChange(changeInfo);
    return this.$q.resolve();
  }

  wasContainerChanged(changedNativeBookmark: NativeBookmarks.BookmarkTreeNode): ng.IPromise<boolean> {
    return this.getNativeContainerIds().then((nativeContainerIds) => {
      return false;
    });
  }

  methodNotApplicable(): ng.IPromise<any> {
    // Unused for this platform
    return this.$q.resolve();
  }
}
