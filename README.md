# Restinfront

Model based Rest API manager.

Retrieve, parse, valid, transform and save data.

## Installation

```sh
npm install restinfront
```

## Usage

### Create a configuration file

config.js

```javascript
import { Model } from 'restinfront'


export class BaseModel extends Model {
  static {
    this.init({
      onFetchError: (response) => {
        console.warn('[Restinfront][Fetch]', error)
      },
      onValidationError: (error) => {
        console.warn('[Restinfront][Validation]', error)
      }
    })
  }
}

export class PrivateModel extends BaseModel {
  static {
    this.init({
      baseUrl: `https://api.example.com/private`,
      authentication: () => store.dispatch('access/retrieveToken')
    })
  }
}

export class PublicModel extends BaseModel {
  static {
    this.init({
      baseUrl: `https://api.example.com/public`,
      authentication: false
    })
  }
}
```

### Define your models

User.js

```javascript
import { PrivateModel, FieldTypes } from './config.js'

import Sponsor from './Sponsor.js'
import Profile from './Profile.js'
import Plan from './Plan.js'


export default class User extends PrivateModel {
  static {
    this.init({
      endpoint: '/users',
      schema: {
        id: {
          type: FieldTypes.UUID, // required
          primaryKey: true, // only once per model
          // defaultValue: // optional | defaultValue from `type` option
          // allowBlank: // optional | false
          // isValid: // optional | (value, data) => true
        },
        createdAt: {
          type: FieldTypes.DATETIME
        },
        firstName: {
          type: FieldTypes.STRING
        },
        lastName: {
          type: FieldTypes.STRING
        },
        email: {
          type: FieldTypes.EMAIL
        },
        password: {
          type: FieldTypes.STRING
        },
        phone: {
          type: FieldTypes.PHONE,
          allowBlank: true
        },
        address: {
          type: FieldTypes.ADDRESS,
          allowBlank: true
        },
        role: {
          type: FieldTypes.STRING
        },
        isActive: {
          type: FieldTypes.BOOLEAN
        },
        // One-to-One relation
        profile: {
          type: FieldTypes.HASONE(Profile)
        },
        // One-to-Many relation
        plans: {
          type: FieldTypes.HASMANY(Plan)
        },
        // Many-to-One relation
        sponsor: {
          type: FieldTypes.BELONGSTO(Sponsor)
        },
        // Virtual fields
        newEmail: {
          type: FieldTypes.EMAIL
        },
        newPassword: {
          type: FieldTypes.STRING
        }
      }
    })
  }
}
```

### Manage your data

UserEdit.vue

```javascript
<script>

import User from './User.js'
import Plan from './Plan.js'


export default {
  props: {
    id: {
      type: String
    }
  },

  data () {
    return {
      // Create a new user with default values
      user: new User({}),
      // Create an empty collection of your app plans
      plans: new Plan([])
    }
  },

  async created () {
    // Note: Data will be reactives
    // Result fetched from api will mutate data

    // Get all plans of your app
    // .get(url: string)
    await this.plans.get()
    // Some flags are mutated during the fetch operation:
    // this.plans.$state.get.inprogress
    // this.plans.$state.get.success
    // this.plans.$state.get.failure    

    if (this.id) {
      // Get the existing user if there is an id in the URL
      // .get(url: string)
      await this.user.get(this.id)
      // Some flags are mutated during the fetch operation:
      // this.user.$state.get.inprogress
      // this.user.$state.get.success
      // this.user.$state.get.failure
      // this.user.$state.save.inprogress
      // this.user.$state.save.success
      // this.user.$state.save.failure
    }
  },

  methods: {
    async saveUser () {
      if (
        // Data validation is required before .put() & .post()
        this.user.valid([
          // Validation of direct field
          'firstName',
          // Nested validation of BELONGSTO
          ['sponsor', [
              'code'
          ]],
          // Nested validation of HASONE
          ['profile', [
            'picture'
          ]],
          // Nested validation of HASMANY
          ['plans', [
            'name',
            'price'
          ]]
        ])
      ) {
        // .save() is a syntax sugar for .put() or .post()
        await this.user.save()

        if (this.user.$state.save.success) {
          if (this.id) {
            console.log('Yeah! user updated !')
          } else {
            console.log('Yeah! user created !')
          }
        }
      }
    }
  }
}

</script>
```
```html
<template>

  <div>
    <h1>User example</h1>

    <form
      id="UserEdit"
      @submit.prevent="saveUser()"
    >
      <div :class="{ 'form-error': user.error('firstName') }">
        <input
          v-model="user.firstName"
          type="text"
          placeholder="Firstname"
        >
      </div>

      <div :class="{ 'form-error': user.profile.error('picture') }">
        <input
          v-model="user.profile.picture"
          type="file"
          placeholder="Avatar"
        >
      </div>

      <div :class="{ 'form-error': user.sponsor.error('code') }">
        <input
          v-model="user.sponsor.code"
          type="text"
          placeholder="Sponsor code"
        >
      </div>

      <div :class="{ 'form-error': user.error('plans') }">
        <div
          v-for="plan of plans.items()"
          :key="plan.id"
        >
          <label>
            <input
              type="checkbox"
              :value="user.plans.exists(plan)"
              @change="user.plans.toggle(plan)"
            >
            {{plan.name}} - {{plan.price}}
          </label>
        </div>
      </div>

      <button type="submit">
        <span v-if="user.$state.save.inprogress">Save in progress</span>
        <span v-else>Save</span>
      </button>
    </form>
  </div>

</template>
```

## Contributions
- Tests
- Docs
