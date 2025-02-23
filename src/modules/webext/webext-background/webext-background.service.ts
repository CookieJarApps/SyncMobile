import angular from 'angular';
import { Injectable } from 'angular-ts-decorators';
import autobind from 'autobind-decorator';
import * as detectBrowser from 'detect-browser';
import { Alarms, browser, Downloads, Notifications } from 'webextension-polyfill-ts';
import { Alert } from '../../shared/alert/alert.interface';
import { AlertService } from '../../shared/alert/alert.service';
import { BackupRestoreService } from '../../shared/backup-restore/backup-restore.service';
import { BookmarkHelperService } from '../../shared/bookmark/bookmark-helper/bookmark-helper.service';
import * as Exceptions from '../../shared/exception/exception';
import { ExceptionHandler } from '../../shared/exception/exception.interface';
import Globals from '../../shared/global-shared.constants';
import { MessageCommand } from '../../shared/global-shared.enum';
import { PlatformService } from '../../shared/global-shared.interface';
import { LogService } from '../../shared/log/log.service';
import { NetworkService } from '../../shared/network/network.service';
import { SettingsService } from '../../shared/settings/settings.service';
import { StoreKey } from '../../shared/store/store.enum';
import { StoreService } from '../../shared/store/store.service';
import { SyncType } from '../../shared/sync/sync.enum';
import { Sync, SyncResult } from '../../shared/sync/sync.interface';
import { SyncService } from '../../shared/sync/sync.service';
import { UpgradeService } from '../../shared/upgrade/upgrade.service';
import { UtilityService } from '../../shared/utility/utility.service';
import { FirefoxBookmarkService } from '../firefox/shared/firefox-bookmark/firefox-bookmark.service';
import { BookmarkIdMapperService } from '../shared/bookmark-id-mapper/bookmark-id-mapper.service';
import { DownloadFileMessage, EnableAutoBackUpMessage, Message, SyncBookmarksMessage } from '../webext.interface';

@autobind
@Injectable('WebExtBackgroundService')
export class WebExtBackgroundService {
  Strings = require('../../../../res/strings/en.json');

  $exceptionHandler: ExceptionHandler;
  $q: ng.IQService;
  $timeout: ng.ITimeoutService;
  alertSvc: AlertService;
  backupRestoreSvc: BackupRestoreService;
  bookmarkIdMapperSvc: BookmarkIdMapperService;
  bookmarkHelperSvc: BookmarkHelperService;
  bookmarkSvc: FirefoxBookmarkService;
  logSvc: LogService;
  networkSvc: NetworkService;
  platformSvc: PlatformService;
  settingsSvc: SettingsService;
  storeSvc: StoreService;
  syncSvc: SyncService;
  upgradeSvc: UpgradeService;
  utilitySvc: UtilityService;

  notificationClickHandlers: any[] = [];

  static $inject = [
    '$exceptionHandler',
    '$q',
    '$timeout',
    'AlertService',
    'BackupRestoreService',
    'BookmarkHelperService',
    'BookmarkIdMapperService',
    'BookmarkService',
    'LogService',
    'NetworkService',
    'PlatformService',
    'SettingsService',
    'StoreService',
    'SyncService',
    'UpgradeService',
    'UtilityService'
  ];
  constructor(
    $exceptionHandler: ExceptionHandler,
    $q: ng.IQService,
    $timeout: ng.ITimeoutService,
    AlertSvc: AlertService,
    BackupRestoreSvc: BackupRestoreService,
    BookmarkHelperSvc: BookmarkHelperService,
    BookmarkIdMapperSvc: BookmarkIdMapperService,
    BookmarkSvc: FirefoxBookmarkService,
    LogSvc: LogService,
    NetworkSvc: NetworkService,
    PlatformSvc: PlatformService,
    SettingsSvc: SettingsService,
    StoreSvc: StoreService,
    SyncSvc: SyncService,
    UpgradeSvc: UpgradeService,
    UtilitySvc: UtilityService
  ) {
    this.$exceptionHandler = $exceptionHandler;
    this.$q = $q;
    this.$timeout = $timeout;
    this.alertSvc = AlertSvc;
    this.backupRestoreSvc = BackupRestoreSvc;
    this.bookmarkIdMapperSvc = BookmarkIdMapperSvc;
    this.bookmarkHelperSvc = BookmarkHelperSvc;
    this.bookmarkSvc = BookmarkSvc;
    this.logSvc = LogSvc;
    this.networkSvc = NetworkSvc;
    this.platformSvc = PlatformSvc;
    this.settingsSvc = SettingsSvc;
    this.storeSvc = StoreSvc;
    this.syncSvc = SyncSvc;
    this.upgradeSvc = UpgradeSvc;
    this.utilitySvc = UtilitySvc;

    browser.alarms.onAlarm.addListener(this.onAlarm);
    browser.notifications.onClicked.addListener(this.onNotificationClicked);
    browser.notifications.onClosed.addListener(this.onNotificationClosed);
    browser.runtime.onMessage.addListener(this.onMessage);
  }

  checkForNewVersion(): void {
    this.platformSvc.getAppVersion().then((appVersion) => {
      return this.utilitySvc.checkForNewVersion(appVersion).then((newVersion) => {
        if (!newVersion) {
          return;
        }

        const alert: Alert = {
          message: this.platformSvc
            .getI18nString(this.Strings.Alert.AppUpdateAvailable.Message)
            .replace('{version}', newVersion),
          title: this.platformSvc.getI18nString(this.Strings.Alert.AppUpdateAvailable.Title)
        };
        this.displayAlert(alert, Globals.ReleaseNotesUrlStem + newVersion.replace(/^v/, ''));
      });
    });
  }

  checkForSyncUpdates(): ng.IPromise<SyncResult | void> {
    // Exit if currently syncing
    const currentSync = this.syncSvc.getCurrentSync();
    if (currentSync) {
      return this.$q.resolve();
    }

    // Exit if sync not enabled
    return this.utilitySvc
      .isSyncEnabled()
      .then((syncEnabled) => {
        if (!syncEnabled) {
          return;
        }

        return this.syncSvc.checkForUpdates().then((updatesAvailable) => {
          if (!updatesAvailable) {
            return;
          }

          // Queue sync
          return this.platformSvc.queueSync({
            type: SyncType.Local
          });
        });
      })
      .catch(this.checkForSyncUpdatesFailed);
  }

  checkForSyncUpdatesFailed(err: Error): void {
    // Don't display alert if sync failed due to network connection
    if (this.networkSvc.isNetworkConnectionError(err)) {
      this.logSvc.logInfo('Could not check for updates, no connection');
      return;
    }

    // Handle sync removed from service
    if (err instanceof Exceptions.SyncNotFoundException) {
      this.syncSvc.setSyncRemoved();
    }

    throw err;
  }

  checkForSyncUpdatesOnStartup(): ng.IPromise<SyncResult | void> {
    return this.$q<boolean>((resolve, reject) => {
      return this.utilitySvc.isSyncEnabled().then((syncEnabled) => {
        if (!syncEnabled) {
          return resolve();
        }

        // Check for updates to synced bookmarks
        this.syncSvc
          .checkForUpdates()
          .then(resolve)
          .catch((err) => {
            if (!(err instanceof Exceptions.HttpRequestFailedException)) {
              return reject(err);
            }

            // If request failed, retry once
            this.logSvc.logInfo('Connection to API failed, retrying check for sync updates momentarily');
            this.$timeout(() => {
              this.utilitySvc.isSyncEnabled().then((syncEnabledAfterError) => {
                if (!syncEnabledAfterError) {
                  this.logSvc.logInfo('Sync was disabled before retry attempted');
                  return reject(new Exceptions.HttpRequestCancelledException());
                }
                this.syncSvc.checkForUpdates().then(resolve).catch(reject);
              });
            }, 5000);
          });
      });
    })
      .then((updatesAvailable) => {
        if (!updatesAvailable) {
          return;
        }

        // Queue sync
        return this.platformSvc.queueSync({
          type: SyncType.Local
        });
      })
      .catch(this.checkForSyncUpdatesFailed);
  }

  displayAlert(alert: Alert, url?: string): void {
    // Strip html tags from message
    const urlRegex = new RegExp(Globals.URL.ValidUrlRegex, 'i');
    const urlInAlert = alert.message.match(urlRegex)?.find(Boolean);
    const messageToDisplay = urlInAlert
      ? new DOMParser().parseFromString(`<span>${alert.message}</span>`, 'text/xml').firstElementChild.textContent
      : alert.message;
    const options: Notifications.CreateNotificationOptions = {
      iconUrl: `${Globals.PathToAssets}/notification.svg`,
      message: messageToDisplay,
      title: alert.title,
      type: 'basic'
    };

    // Display notification
    browser.notifications.create(this.utilitySvc.getUniqueishId(), options).then((notificationId) => {
      // Add a click handler to open url if provided or if the message contains a url
      const urlToOpenOnClick = urlInAlert ?? url;
      if (urlToOpenOnClick) {
        const openUrlInNewTab = () => {
          this.platformSvc.openUrl(urlToOpenOnClick);
        };
        this.notificationClickHandlers.push({
          id: notificationId,
          eventHandler: openUrlInNewTab
        });
      }
    });
  }

  getDownloadById(id: number): ng.IPromise<Downloads.DownloadItem> {
    return browser.downloads.search({ id }).then((results) => {
      const download = results[0];
      if ((download ?? undefined) === undefined) {
        this.logSvc.logWarning('Unable to find download');
        return;
      }
      return download;
    });
  }

  init(): void {
    this.logSvc.logInfo('Starting up');

    // Before initialising, check if upgrade required
    this.platformSvc
      .getAppVersion()
      .then(this.upgradeSvc.checkIfUpgradeRequired)
      .then((upgradeRequired) => upgradeRequired && this.upgradeExtension())
      .then(() =>
        this.$q
          .all([
            this.platformSvc.getAppVersion(),
            this.settingsSvc.all(),
            this.storeSvc.get([StoreKey.LastUpdated, StoreKey.SyncId]),
            this.utilitySvc.getServiceUrl(),
            this.utilitySvc.getSyncVersion(),
            this.utilitySvc.isSyncEnabled()
          ])
          .then((data) => {
            const appVersion = data[0];
            const settings = data[1];
            const storeContent = data[2];
            const serviceUrl = data[3];
            const syncVersion = data[4];
            const syncEnabled = data[5];

            // Add useful debug info to beginning of trace log
            const debugInfo = angular.copy(storeContent) as any;
            debugInfo.appVersion = appVersion;
            debugInfo.checkForAppUpdates = settings.checkForAppUpdates;
            debugInfo.platform = detectBrowser.detect();
            debugInfo.platform.name = this.utilitySvc.getBrowserName();
            debugInfo.serviceUrl = serviceUrl;
            debugInfo.syncBookmarksToolbar = settings.syncBookmarksToolbar;
            debugInfo.syncEnabled = syncEnabled;
            debugInfo.syncVersion = syncVersion;
            this.logSvc.logInfo(
              Object.keys(debugInfo)
                .filter((key) => {
                  return debugInfo[key] != null;
                })
                .reduce((prev, current) => {
                  prev[current] = debugInfo[current];
                  return prev;
                }, {})
            );

            // Update browser action icon
            this.platformSvc.refreshNativeInterface(syncEnabled);

            // Check for new app version after a delay
            if (settings.checkForAppUpdates) {
              this.$timeout(this.checkForNewVersion, 5e3);
            }

            // Enable sync and check for updates after a delay to allow for initialising network connection
            if (!syncEnabled) {
              return;
            }
            return this.syncSvc.enableSync().then(() => this.$timeout(this.checkForSyncUpdatesOnStartup, 5e3));
          })
      );
  }

  installExtension(): ng.IPromise<void> {
    // Initialise data storage
    return (
      this.storeSvc
        .init()
        .then(() =>
          this.$q.all([
            this.storeSvc.set(StoreKey.DisplayOtherSyncsWarning, false),
            this.storeSvc.set(StoreKey.DisplayPermissions, false),
            this.storeSvc.set(StoreKey.SyncBookmarksToolbar, false)
          ])
        )
        // Set the initial upgrade version
        .then(() => {
          return this.platformSvc.getAppVersion().then((currentVersion) =>
            this.upgradeSvc.setLastUpgradeVersion(currentVersion).then(() => {
              this.logSvc.logInfo(`Installed ${currentVersion}`);
            })
          );
        })
        .catch((err) => {
          this.$exceptionHandler(err);
          return this.$q.reject(err);
        })
    );
  }

  onAlarm(alarm: Alarms.Alarm): void {
    switch (alarm?.name) {
      case Globals.Alarms.AutoBackUp.Name:
        this.backupRestoreSvc.runAutoBackUp();
        break;
      case Globals.Alarms.SyncUpdatesCheck.Name:
        this.checkForSyncUpdates();
        break;
      default:
    }
  }

  onInstall(event: InputEvent): void {
    // Check if fresh install needed
    const details = angular.element(event.currentTarget as Element).data('details');
    (details?.reason === 'install' ? this.installExtension() : this.$q.resolve()).then(this.init);
  }

  onNotificationClicked(notificationId: string): void {
    // Execute the event handler if one exists and then remove
    const notificationClickHandler = this.notificationClickHandlers.find((x) => {
      return x.id === notificationId;
    });
    if (notificationClickHandler != null) {
      notificationClickHandler.eventHandler();
      browser.notifications.clear(notificationId);
    }
  }

  onNotificationClosed(notificationId: string): void {
    // Remove the handler for this notification if one exists
    const index = this.notificationClickHandlers.findIndex((x) => {
      return x.id === notificationId;
    });
    if (index >= 0) {
      this.notificationClickHandlers.splice(index, 1);
    }
  }

  onMessage(message: Message): Promise<any> {
    // Use native Promise not $q otherwise browser.runtime.sendMessage will return immediately in Firefox
    return new Promise((resolve, reject) => {
      let action: ng.IPromise<any>;
      switch (message.command) {
        // Queue bookmarks sync
        case MessageCommand.SyncBookmarks:
          action = this.runSyncBookmarksCommand(message as SyncBookmarksMessage);
          break;
        // Trigger bookmarks restore
        case MessageCommand.RestoreBookmarks:
          action = this.runRestoreBookmarksCommand(message as SyncBookmarksMessage);
          break;
        // Get current sync in progress
        case MessageCommand.GetCurrentSync:
          action = this.runGetCurrentSyncCommand();
          break;
        // Get current number of syncs on the queue
        case MessageCommand.GetSyncQueueLength:
          action = this.runGetSyncQueueLengthCommand();
          break;
        // Disable sync
        case MessageCommand.DisableSync:
          action = this.runDisableSyncCommand();
          break;
        // Download file
        case MessageCommand.DownloadFile:
          action = this.runDownloadFileCommand(message as DownloadFileMessage);
          break;
        // Enable event listeners
        case MessageCommand.EnableEventListeners:
          action = this.runEnableEventListenersCommand();
          break;
        // Disable event listeners
        case MessageCommand.DisableEventListeners:
          action = this.runDisableEventListenersCommand();
          break;
        // Enable auto back up
        case MessageCommand.EnableAutoBackUp:
          action = this.runEnableAutoBackUpCommand(message as EnableAutoBackUpMessage);
          break;
        // Disable auto back up
        case MessageCommand.DisableAutoBackUp:
          action = this.runDisableAutoBackUpCommand();
          break;
        // Unknown command
        default:
          action = this.$q.reject(new Exceptions.AmbiguousSyncRequestException());
      }
      return action.then(resolve).catch(reject);
    }).catch((err) => {
      // Set message to exception class name so sender can rehydrate the exception on receipt
      err.message = err.constructor.name;
      throw err;
    });
  }

  runDisableAutoBackUpCommand(): ng.IPromise<void> {
    return browser.alarms.clear(Globals.Alarms.AutoBackUp.Name).then(() => {});
  }

  runDisableEventListenersCommand(): ng.IPromise<void> {
    return this.bookmarkSvc.disableEventListeners();
  }

  runDisableSyncCommand(): ng.IPromise<void> {
    return this.syncSvc.disableSync();
  }

  runDownloadFileCommand(message: DownloadFileMessage): ng.IPromise<string | void> {
    const { filename, textContents, displaySaveDialog = true } = message;
    if (!filename) {
      return Promise.reject(new Error('File name parameter missing.'));
    }
    if (!textContents) {
      return Promise.reject(new Error('File contents parameter missing.'));
    }

    return new Promise<string | void>((resolve, reject) => {
      // Use create a new object url using contents and trigger download
      const file = new Blob([textContents], { type: 'text/plain' });
      const url = URL.createObjectURL(file);
      return browser.downloads
        .download({
          filename,
          saveAs: displaySaveDialog,
          url
        })
        .then((downloadId) => {
          const onChangedHandler = (delta: Downloads.OnChangedDownloadDeltaType) => {
            switch (delta.state?.current) {
              case 'complete':
                URL.revokeObjectURL(url);
                browser.downloads.onChanged.removeListener(onChangedHandler);
                this.getDownloadById(downloadId).then((download) => {
                  this.logSvc.logInfo(`Downloaded file ${download.filename}`);
                  resolve(download.filename);
                });
                break;
              case 'interrupted':
                URL.revokeObjectURL(url);
                browser.downloads.onChanged.removeListener(onChangedHandler);
                if (delta.error?.current === 'USER_CANCELED') {
                  resolve();
                } else {
                  reject(new Exceptions.FailedDownloadFileException());
                }
                break;
              default:
            }
          };
          browser.downloads.onChanged.addListener(onChangedHandler);
        }, reject);
    });
  }

  runEnableAutoBackUpCommand(message: EnableAutoBackUpMessage): ng.IPromise<void> {
    const { schedule } = message;

    // Calculate alarm delay from schedule
    let delayInMinutes = 0;
    const now = new Date();
    const runTime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      parseInt(schedule.autoBackUpHour, 10),
      parseInt(schedule.autoBackUpMinute, 10)
    );
    if (runTime < now) {
      runTime.setDate(now.getDate() + 1);
    }
    delayInMinutes = Math.round((runTime.getTime() - now.getTime()) / 1e3 / 60);

    // Calculate alarm period from schedule
    let periodInMinutes;
    switch (schedule.autoBackUpUnit) {
      case 'week':
        periodInMinutes = 60 * 24 * 7;
        break;
      case 'month':
        periodInMinutes = 60 * 24 * (365 / 12);
        break;
      case 'day':
      default:
        periodInMinutes = 60 * 24;
    }
    periodInMinutes *= parseInt(schedule.autoBackUpNumber, 10);

    // Register alarm
    return browser.alarms.clear(Globals.Alarms.AutoBackUp.Name).then(() => {
      return browser.alarms.create(Globals.Alarms.AutoBackUp.Name, {
        delayInMinutes,
        periodInMinutes
      });
    });
  }

  runEnableEventListenersCommand(): ng.IPromise<void> {
    return this.bookmarkSvc.enableEventListeners();
  }

  runGetCurrentSyncCommand(): ng.IPromise<Sync> {
    return this.$q.resolve(this.syncSvc.getCurrentSync());
  }

  runGetSyncQueueLengthCommand(): ng.IPromise<number> {
    return this.$q.resolve(this.syncSvc.getSyncQueueLength());
  }

  runRestoreBookmarksCommand(message: SyncBookmarksMessage): ng.IPromise<SyncResult> {
    const { sync } = message;
    return this.bookmarkSvc.disableEventListeners().then(() => {
      // Queue sync
      return this.syncSvc.queueSync(sync).then(() => ({ success: true }));
    });
  }

  runSyncBookmarksCommand(message: SyncBookmarksMessage): ng.IPromise<SyncResult> {
    const { sync, runSync } = message;
    return this.syncSvc.queueSync(sync, runSync).then(() => ({ success: true }));
  }

  upgradeExtension(): ng.IPromise<void> {
    // Run upgrade process and display notification to user
    return this.platformSvc
      .getAppVersion()
      .then(this.upgradeSvc.upgrade)
      .then(() => {
        return this.platformSvc.getAppVersion().then((appVersion) => {
          const alert: Alert = {
            message: this.platformSvc.getI18nString(this.Strings.Alert.AppUpdated.Message),
            title: `${this.platformSvc.getI18nString(this.Strings.Alert.AppUpdated.Title)} ${appVersion}`
          };
          this.displayAlert(alert, Globals.ReleaseNotesUrlStem + appVersion);
          return this.storeSvc.set(StoreKey.DisplayUpdated, true);
        });
      });
  }
}
