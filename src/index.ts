import {
  type Graffiti,
  type GraffitiObject,
  type GraffitiObjectBase,
  type GraffitiLocation,
  type GraffitiStream,
  type GraffitiLoginEvent,
  type GraffitiLogoutEvent,
  GraffitiErrorNotFound,
  GraffitiErrorSchemaMismatch,
  GraffitiErrorForbidden,
  GraffitiErrorPatchError,
} from "@graffiti-garden/api";
import { GraffitiSynchronized } from "./sync";
import PouchDB from "pouchdb";
import {
  locationToUri,
  uriToLocation,
  unpackLocationOrUri,
  randomBase64,
  applyPropPatch,
  attemptAjvCompile,
  maskObject,
  isAllowed,
} from "./utilities";
import { Repeater } from "@repeaterjs/repeater";

export interface GraffitiPouchDBOptions {
  sourceName?: string;
  pouchDBOptions?: PouchDB.Configuration.DatabaseConfiguration;
}

export class GraffitiPouchDB extends GraffitiSynchronized {
  protected readonly db: PouchDB.Database<GraffitiObjectBase>;
  protected readonly source: string;
  locationToUri = locationToUri;
  uriToLocation = uriToLocation;

  constructor(options?: GraffitiPouchDBOptions) {
    super();
    this.source = options?.sourceName ?? "local";
    const pouchDbOptions = {
      name: "graffitiDb",
      ...options?.pouchDBOptions,
    };
    this.db = new PouchDB<GraffitiObjectBase>(
      pouchDbOptions.name,
      pouchDbOptions,
    );

    this.db
      //@ts-ignore
      .put({
        _id: "_design/index3",
        views: {
          byChannelAndLastModified: {
            map: function (object: GraffitiObjectBase) {
              const paddedLastModified = object.lastModified
                .toString()
                .padStart(15, "0");
              object.channels.forEach(function (channel) {
                const id =
                  encodeURIComponent(channel) + "/" + paddedLastModified;
                //@ts-ignore
                emit(id);
              });
            }.toString(),
          },
        },
      })
      //@ts-ignore
      .catch((error) => {
        if (
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "conflict"
        ) {
          // Design document already exists
          return;
        } else {
          throw error;
        }
      });

    // Look for any existing sessions
    const sessionRestorer = async () => {
      // Allow listeners to be added first
      await Promise.resolve();

      if (typeof window === "undefined") return;
      const actor = window.localStorage.getItem("graffitiActor");
      if (actor) {
        const event: GraffitiLoginEvent = new CustomEvent("login", {
          detail: { session: { actor } },
        });
        this.sessionEvents.dispatchEvent(event);
      }
    };
    sessionRestorer();
  }

  protected async queryByLocation(location: GraffitiLocation) {
    const uri = locationToUri(location) + "/";
    const results = await this.db.allDocs({
      startkey: uri,
      endkey: uri + "\uffff", // \uffff is the last unicode character
      include_docs: true,
    });
    const docs = results.rows
      .map((row) => row.doc)
      // Remove undefined docs
      .reduce<
        PouchDB.Core.ExistingDocument<
          GraffitiObjectBase & PouchDB.Core.AllDocsMeta
        >[]
      >((acc, doc) => {
        if (doc) acc.push(doc);
        return acc;
      }, [])
      // Remove tombstones
      .filter((doc) => !doc.tombstone);
    return docs;
  }

  protected docId(location: GraffitiLocation) {
    return locationToUri(location) + "/" + randomBase64();
  }

  protected _get: Graffiti["get"] = async (...args) => {
    const [locationOrUri, schema, session] = args;
    const { location } = unpackLocationOrUri(locationOrUri);

    const docs = await this.queryByLocation(location);
    if (!docs.length) throw new GraffitiErrorNotFound();

    // Get the most recent document
    const doc = docs.reduce((a, b) =>
      a.lastModified > b.lastModified ? a : b,
    );

    // Strip out the _id and _rev
    const { _id, _rev, ...object } = doc;

    // Make sure the user is allowed to see it
    if (!isAllowed(doc, session)) throw new GraffitiErrorNotFound();

    // Mask out the allowed list and channels
    // if the user is not the owner
    maskObject(object, [], session);

    const validate = attemptAjvCompile(this.ajv, schema);
    if (!validate(object)) {
      throw new GraffitiErrorSchemaMismatch();
    }
    return object;
  };

  protected async deleteBefore(
    location: GraffitiLocation,
    modifiedBefore?: number,
  ) {
    const docsAtLocation = await this.queryByLocation(location);

    // Delete all old docs
    const docs = docsAtLocation.filter(
      (doc) => !modifiedBefore || doc.lastModified < modifiedBefore,
    );

    // For docs with the same timestamp,
    // keep the one with the highest _id
    // to break concurrency ties
    const concurrentDocsAll = docsAtLocation.filter(
      (doc) => modifiedBefore && doc.lastModified === modifiedBefore,
    );
    if (concurrentDocsAll.length) {
      const keepDoc = concurrentDocsAll.reduce((a, b) =>
        a._id > b._id ? a : b,
      );
      const concurrentDocsToDelete = concurrentDocsAll.filter(
        (doc) => doc._id !== keepDoc._id,
      );
      docs.push(...concurrentDocsToDelete);
    }

    let deletedObject: GraffitiObjectBase | undefined = undefined;
    // Go through documents oldest to newest
    for (const doc of docs.sort((a, b) => a.lastModified - b.lastModified)) {
      // Change it's tombstone to true
      // and update it's timestamp
      const deletedDoc = {
        ...doc,
        tombstone: true,
        lastModified: modifiedBefore ?? new Date().getTime(),
      };
      try {
        await this.db.put(deletedDoc);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "conflict"
        ) {
          // Document was already deleted
          continue;
        }
      }
      const { _id, _rev, ...object } = deletedDoc;
      deletedObject = object;
    }

    return deletedObject;
  }

  protected _delete: Graffiti["delete"] = async (...args) => {
    const [locationOrUri, session] = args;
    const { location } = unpackLocationOrUri(locationOrUri);
    if (location.actor !== session.actor) {
      throw new GraffitiErrorForbidden();
    }

    const deletedObject = await this.deleteBefore(location);
    if (!deletedObject) {
      throw new GraffitiErrorNotFound();
    }
    return deletedObject;
  };

  protected _put: Graffiti["put"] = async (...args) => {
    const [objectPartial, session] = args;
    if (objectPartial.actor && objectPartial.actor !== session.actor) {
      throw new GraffitiErrorForbidden();
    }

    const object: GraffitiObjectBase = {
      value: objectPartial.value,
      channels: objectPartial.channels,
      allowed: objectPartial.allowed,
      name: objectPartial.name ?? randomBase64(),
      source: "local",
      actor: session.actor,
      tombstone: false,
      lastModified: new Date().getTime(),
    };

    await this.db.put({
      _id: this.docId(object),
      ...object,
    });

    // Delete the old object
    const previousObject = await this.deleteBefore(object, object.lastModified);
    if (previousObject) {
      return previousObject;
    } else {
      return {
        ...object,
        value: {},
        channels: [],
        allowed: undefined,
        tombstone: true,
      };
    }
  };

  protected _patch: Graffiti["patch"] = async (...args) => {
    const [patch, locationOrUri, session] = args;
    const { location } = unpackLocationOrUri(locationOrUri);
    if (location.actor !== session.actor) {
      throw new GraffitiErrorForbidden();
    }
    const originalObject = await this._get(locationOrUri, {}, session);

    // Patch it outside of the database
    const patchObject: GraffitiObjectBase = { ...originalObject };
    for (const prop of ["value", "channels", "allowed"] as const) {
      applyPropPatch(prop, patch, patchObject);
    }

    // Make sure the value is an object
    if (
      typeof patchObject.value !== "object" ||
      Array.isArray(patchObject.value) ||
      !patchObject.value
    ) {
      throw new GraffitiErrorPatchError("value is no longer an object");
    }

    // Make sure the channels are an array of strings
    if (
      !Array.isArray(patchObject.channels) ||
      !patchObject.channels.every((channel) => typeof channel === "string")
    ) {
      throw new GraffitiErrorPatchError(
        "channels are no longer an array of strings",
      );
    }

    // Make sure the allowed list is an array of strings or undefined
    if (
      patchObject.allowed &&
      (!Array.isArray(patchObject.allowed) ||
        !patchObject.allowed.every((allowed) => typeof allowed === "string"))
    ) {
      throw new GraffitiErrorPatchError(
        "allowed list is not an array of strings",
      );
    }

    patchObject.lastModified = new Date().getTime();
    await this.db.put({
      ...patchObject,
      _id: this.docId(patchObject),
    });

    // Delete the old object
    await this.deleteBefore(patchObject, patchObject.lastModified);

    return {
      ...originalObject,
      tombstone: true,
      lastModified: patchObject.lastModified,
    };
  };

  protected _discover: Graffiti["discover"] = (...args) => {
    const [channels, schema, session] = args;

    const validate = attemptAjvCompile(this.ajv, schema);

    // Use the index for queries over ranges of lastModified
    let startKeyAppend = "";
    let endKeyAppend = "\uffff";
    const lastModifiedSchema = schema.properties?.lastModified;
    if (lastModifiedSchema?.minimum) {
      let minimum = Math.ceil(lastModifiedSchema.minimum);
      minimum === lastModifiedSchema.minimum &&
        lastModifiedSchema.exclusiveMinimum &&
        minimum++;
      startKeyAppend = minimum.toString().padStart(15, "0");
    }
    if (lastModifiedSchema?.maximum) {
      let maximum = Math.floor(lastModifiedSchema.maximum);
      maximum === lastModifiedSchema.maximum &&
        lastModifiedSchema.exclusiveMaximum &&
        maximum--;
      endKeyAppend = maximum.toString().padStart(15, "0");
    }

    const repeater: GraffitiStream<GraffitiObject<typeof schema>> =
      new Repeater(async (push, stop) => {
        const processedIds = new Set<string>();

        for (const channel of channels) {
          const encodedChannel = encodeURIComponent(channel);
          const startkey = encodedChannel + "/" + startKeyAppend;
          const endkey = encodedChannel + "/" + endKeyAppend;

          const result = await this.db.query<GraffitiObjectBase>(
            "index3/byChannelAndLastModified",
            { startkey, endkey, include_docs: true },
          );

          for (const row of result.rows) {
            const doc = row.doc;
            if (!doc) continue;

            const { _id, _rev, ...object } = doc;

            // Don't double return the same object
            // (which can happen if it's in multiple channels)
            if (processedIds.has(_id)) continue;
            processedIds.add(_id);

            // Make sure the user is allowed to see it
            if (!isAllowed(doc, session)) continue;

            // Mask out the allowed list and channels
            // if the user is not the owner
            maskObject(object, channels, session);

            // Check that it matches the schema
            if (validate(object)) {
              push({
                value: object,
              });
            }
          }
        }
        stop();
      });

    return repeater;
  };

  login: Graffiti["login"] = async (actor, state) => {
    if (!actor && typeof window !== "undefined") {
      const response = window.prompt(
        `This is an insecure implementation of the Graffiti API \
for *demo purposes only*. Do not store any sensitive information \
here.\
\n\n\
Simply choose a username to log in.`,
      );
      if (response) actor = response;
    }

    let detail: GraffitiLoginEvent["detail"];
    if (!actor) {
      detail = {
        state,
        error: new Error("No actor ID provided to login"),
      };
    } else {
      // try to store it in the database
      const session = { actor };

      if (typeof window !== "undefined") {
        window.localStorage.setItem("graffitiActor", actor);
      }

      detail = {
        state,
        session,
      };
    }

    const event: GraffitiLoginEvent = new CustomEvent("login", { detail });
    this.sessionEvents.dispatchEvent(event);
  };

  logout: Graffiti["logout"] = async (session, state) => {
    let exists = true;
    if (typeof window !== "undefined") {
      exists = !!window.localStorage.getItem("graffitiActor");
      if (exists) {
        window.localStorage.removeItem("graffitiActor");
      }
    }

    const detail: GraffitiLogoutEvent["detail"] = exists
      ? {
          state,
          actor: session.actor,
        }
      : {
          state,
          actor: session.actor,
          error: new Error("Not logged in with that actor"),
        };

    const event: GraffitiLogoutEvent = new CustomEvent("logout", { detail });
    this.sessionEvents.dispatchEvent(event);
  };

  sessionEvents: Graffiti["sessionEvents"] = new EventTarget();

  listChannels: Graffiti["listChannels"] = (...args) => {
    // TODO
    return (async function* () {})();
  };

  listOrphans: Graffiti["listOrphans"] = (...args) => {
    // TODO
    return (async function* () {})();
  };
}
