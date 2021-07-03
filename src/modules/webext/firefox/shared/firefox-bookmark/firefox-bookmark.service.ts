import angular from 'angular';
import { Injectable } from 'angular-ts-decorators';
import autobind from 'autobind-decorator';
import { Bookmarks as NativeBookmarks, browser } from 'webextension-polyfill-ts';
import { BookmarkContainer } from '../../../../shared/bookmark/bookmark.enum';
import { Bookmark } from '../../../../shared/bookmark/bookmark.interface';
import {
  ContainerNotFoundException,
  FailedCreateNativeBookmarksException
} from '../../../../shared/exception/exception';
import { WebExtBookmarkService } from '../../../shared/webext-bookmark/webext-bookmark.service';

@autobind
@Injectable('BookmarkService')
export class FirefoxBookmarkService extends WebExtBookmarkService {
  unsupportedContainers = [];

  clearNativeBookmarks(): ng.IPromise<void> {
    // Get native container ids
    return this.$q.resolve();
  }

  createNativeBookmarksFromBookmarks(): ng.IPromise<number> {
    return this.methodNotApplicable();
  }

  createNativeSeparator(parentId: string): ng.IPromise<NativeBookmarks.BookmarkTreeNode> {
    const newSeparator: NativeBookmarks.CreateDetails = {
      parentId,
      type: 'separator'
    };
    return browser.bookmarks.create(newSeparator).catch((err) => {
      this.logSvc.logInfo('Failed to create native separator');
      throw new FailedCreateNativeBookmarksException(undefined, err);
    });
  }

  disableEventListeners(): ng.IPromise<void> {
    return this.$q.resolve();
  }

  enableEventListeners(): ng.IPromise<void> {
    return this.$q.resolve();
  }

  ensureContainersExist(bookmarks: Bookmark[]): Bookmark[] {
    return bookmarks;
  }

  fixMultipleMoveOldIndexes(): void {
    const processBatch = (batch) => {
      // Adjust oldIndexes if bookmarks moved to different parent or to higher indexes
      if (batch[0].parentId !== batch[0].oldParentId || batch[0].index > batch[0].oldIndex) {
        for (let i = batch.length - 1; i >= 0; i -= 1) {
          batch[i].oldIndex -= 1;
        }
      }
    };

    const finalBatch = this.nativeBookmarkEventsQueue.reduce((currentBatch, currentEvent, currentIndex) => {
      // Check the current event is a move
      if (currentEvent[0] === this.syncNativeBookmarkMoved) {
        // If no events in batch, add this as the first and continue
        if (currentBatch.length === 0) {
          currentBatch.push(currentEvent[1][1]);
          return currentBatch;
        }

        // Otherwise check if this is part of the batch (will have same parent and index as first event)
        const currentMoveInfo = currentEvent[1][1];
        if (
          currentMoveInfo.parentId === currentBatch[0].parentId &&
          (currentMoveInfo.index === currentBatch[0].index ||
            currentMoveInfo.index === this.nativeBookmarkEventsQueue[currentIndex - 1][1][1].index + 1)
        ) {
          currentBatch.push(currentMoveInfo);
          return currentBatch;
        }
      }

      if (currentBatch.length > 0) {
        // Process current batch
        processBatch(currentBatch);
      }

      // Return empty batch
      return [];
    }, []);

    if (finalBatch.length > 0) {
      // Process final batch
      processBatch(finalBatch);
    }
  }

  getNativeBookmarksAsBookmarks(): ng.IPromise<Bookmark[]> {
    let allNativeBookmarks = [];

    // Get native container ids
    return this.getNativeContainerIds()
      .then((nativeContainerIds) => {
        const menuBookmarksId = nativeContainerIds.get(BookmarkContainer.Menu);
        const mobileBookmarksId = nativeContainerIds.get(BookmarkContainer.Mobile);
        const otherBookmarksId = nativeContainerIds.get(BookmarkContainer.Other);
        const toolbarBookmarksId = nativeContainerIds.get(BookmarkContainer.Toolbar);

        // Get menu bookmarks
        const getMenuBookmarks =
          menuBookmarksId === undefined
            ? Promise.resolve<Bookmark[]>(undefined)
            : browser.bookmarks.getSubTree(menuBookmarksId).then((subTree) => {
                const menuBookmarks = subTree[0];
                // Add all bookmarks into flat array
                this.bookmarkHelperSvc.eachBookmark(menuBookmarks.children, (bookmark) => {
                  allNativeBookmarks.push(bookmark);
                });
                return this.bookmarkHelperSvc.getNativeBookmarksAsBookmarks(menuBookmarks.children);
              });

        // Get mobile bookmarks
        const getMobileBookmarks =
          mobileBookmarksId === undefined
            ? Promise.resolve<Bookmark[]>(undefined)
            : browser.bookmarks.getSubTree(mobileBookmarksId).then((subTree) => {
                const mobileBookmarks = subTree[0];
                // Add all bookmarks into flat array
                this.bookmarkHelperSvc.eachBookmark(mobileBookmarks.children, (bookmark) => {
                  allNativeBookmarks.push(bookmark);
                });
                return this.bookmarkHelperSvc.getNativeBookmarksAsBookmarks(mobileBookmarks.children);
              });

        // Get other bookmarks
        const getOtherBookmarks =
          otherBookmarksId === undefined
            ? Promise.resolve<Bookmark[]>(undefined)
            : browser.bookmarks.getSubTree(otherBookmarksId).then((subTree) => {
                const otherBookmarks = subTree[0];
                if (otherBookmarks.children.length === 0) {
                  return;
                }

                // Add all bookmarks into flat array
                this.bookmarkHelperSvc.eachBookmark(otherBookmarks.children, (bookmark) => {
                  allNativeBookmarks.push(bookmark);
                });

                // Convert native bookmarks sub tree to bookmarks
                const bookmarks = this.bookmarkHelperSvc.getNativeBookmarksAsBookmarks(otherBookmarks.children);

                // Remove any unsupported container folders present
                const bookmarksWithoutContainers = bookmarks.filter((x) => {
                  return !this.unsupportedContainers.find((y) => {
                    return y === x.title;
                  });
                });
                return bookmarksWithoutContainers;
              });

        // Get toolbar bookmarks if enabled
        const getToolbarBookmarks =
          toolbarBookmarksId === undefined
            ? this.$q.resolve<Bookmark[]>(undefined)
            : browser.bookmarks.getSubTree(toolbarBookmarksId).then((results) => {
                const toolbarBookmarks = results[0];
                return this.settingsSvc.syncBookmarksToolbar().then((syncBookmarksToolbar) => {
                  if (syncBookmarksToolbar && toolbarBookmarks.children.length > 0) {
                    // Add all bookmarks into flat array
                    this.bookmarkHelperSvc.eachBookmark(toolbarBookmarks.children, (bookmark) => {
                      allNativeBookmarks.push(bookmark);
                    });
                    return this.bookmarkHelperSvc.getNativeBookmarksAsBookmarks(toolbarBookmarks.children);
                  }
                });
              });

        return this.$q.all([getMenuBookmarks, getMobileBookmarks, getOtherBookmarks, getToolbarBookmarks]);
      })
      .then((results) => {
        const menuBookmarks = results[0];
        const mobileBookmarks = results[1];
        const otherBookmarks = results[2];
        const toolbarBookmarks = results[3];
        const bookmarks: Bookmark[] = [];

        // Add other container if bookmarks present
        const otherContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Other, bookmarks, true);
        if (otherBookmarks?.length > 0) {
          otherContainer.children = otherBookmarks;
        }

        // Add toolbar container if bookmarks present
        const toolbarContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Toolbar, bookmarks, true);
        if (toolbarBookmarks?.length > 0) {
          toolbarContainer.children = toolbarBookmarks;
        }

        // Add menu container if bookmarks present
        const menuContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Menu, bookmarks, true);
        if (menuBookmarks?.length > 0) {
          menuContainer.children = menuBookmarks;
        }

        // Add mobile container if bookmarks present
        const mobileContainer = this.bookmarkHelperSvc.getContainer(BookmarkContainer.Mobile, bookmarks, true);
        if (mobileBookmarks?.length > 0) {
          mobileContainer.children = mobileBookmarks;
        }

        // Filter containers from flat array of bookmarks
        [otherContainer, toolbarContainer, menuContainer, mobileContainer].forEach((container) => {
          if (!container) {
            return;
          }

          allNativeBookmarks = allNativeBookmarks.filter((bookmark) => {
            return bookmark.title !== container.title;
          });
        });

        // Sort by date added asc
        allNativeBookmarks = allNativeBookmarks.sort((x, y) => {
          return x.dateAdded - y.dateAdded;
        });

        // Iterate native bookmarks to add unique bookmark ids in correct order
        allNativeBookmarks.forEach((nativeBookmark) => {
          this.bookmarkHelperSvc.eachBookmark(bookmarks, (bookmark) => {
            if (
              !bookmark.id &&
              ((!nativeBookmark.url && bookmark.title === nativeBookmark.title) ||
                (nativeBookmark.url && bookmark.url === nativeBookmark.url))
            ) {
              bookmark.id = this.bookmarkHelperSvc.getNewBookmarkId(bookmarks);
            }
          });
        });

        // Find and fix any bookmarks missing ids
        this.bookmarkHelperSvc.eachBookmark(bookmarks, (bookmark) => {
          if (!bookmark.id) {
            bookmark.id = this.bookmarkHelperSvc.getNewBookmarkId(bookmarks);
          }
        });

        return bookmarks;
      });
  }

  getNativeContainerIds(): ng.IPromise<Map<BookmarkContainer, string>> {
    return this.utilitySvc
      .isSyncEnabled()
      .then((syncEnabled) => (syncEnabled ? this.bookmarkHelperSvc.getCachedBookmarks() : undefined))
      .then((bookmarks) => {
        // Initialise container ids object using containers defined in bookmarks
        const containerIds = new Map<BookmarkContainer, string>();
        if (!angular.isUndefined(bookmarks)) {
          bookmarks.forEach((x) => {
            containerIds.set(x.title as BookmarkContainer, undefined);
          });
        }

        // Populate container ids
        return browser.bookmarks.getTree().then((tree) => {
          // Get the root child nodes
          const menuBookmarksNode = tree[0].children.find((x) => {
            return x.id === 'menu________';
          });
          const mobileBookmarksNode = tree[0].children.find((x) => {
            return x.id === 'mobile______';
          });
          const otherBookmarksNode = tree[0].children.find((x) => {
            return x.id === 'unfiled_____';
          });
          const toolbarBookmarksNode = tree[0].children.find((x) => {
            return x.id === 'toolbar_____';
          });

          // Throw an error if a native container is not found
          if (!menuBookmarksNode || !mobileBookmarksNode || !otherBookmarksNode || !toolbarBookmarksNode) {
            if (!menuBookmarksNode) {
              this.logSvc.logWarning('Missing container: menu bookmarks');
            }
            if (!mobileBookmarksNode) {
              this.logSvc.logWarning('Missing container: mobile bookmarks');
            }
            if (!otherBookmarksNode) {
              this.logSvc.logWarning('Missing container: other bookmarks');
            }
            if (!toolbarBookmarksNode) {
              this.logSvc.logWarning('Missing container: toolbar bookmarks');
            }
            throw new ContainerNotFoundException();
          }

          // Add container ids to result
          containerIds.set(BookmarkContainer.Menu, menuBookmarksNode.id);
          containerIds.set(BookmarkContainer.Mobile, mobileBookmarksNode.id);
          containerIds.set(BookmarkContainer.Other, otherBookmarksNode.id);
          containerIds.set(BookmarkContainer.Toolbar, toolbarBookmarksNode.id);
          return containerIds;
        });
      });
  }

  processNativeBookmarkEventsQueue(): void {
    // Fix incorrect oldIndex values for multiple moves
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1556427
    this.fixMultipleMoveOldIndexes();
    super.processNativeBookmarkEventsQueue();
  }

  syncNativeBookmarkChanged(id: string): ng.IPromise<void> {
    return this.$q.resolve();
  }

  syncNativeBookmarkCreated(id: string, nativeBookmark: NativeBookmarks.BookmarkTreeNode): ng.IPromise<void> {
    return this.$q.resolve();
  }

  syncNativeBookmarkMoved(id: string, moveInfo: NativeBookmarks.OnMovedMoveInfoType): ng.IPromise<void> {
    return this.$q.resolve();
  }

  methodNotApplicable(): ng.IPromise<any> {
    // Unused for this platform
    return this.$q.resolve();
  }
}
